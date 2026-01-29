package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type Alert struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Description     string    `json:"description"`
	Query           string    `json:"query"`
	Condition       string    `json:"condition"`
	IntervalSeconds int       `json:"interval_seconds"`
	CooldownSeconds int       `json:"cooldown_seconds"`
	Recipients      []string  `json:"recipients"`
	Subject         string    `json:"subject"`
	LastTriggeredAt time.Time `json:"last_triggered_at"`
}

type AlertState struct {
	LastRun time.Time
}

func main() {
	host := getEnv("CLICKHOUSE_HOST", "clickhouse")
	port := getEnv("CLICKHOUSE_PORT", "9000")
	database := getEnv("CLICKHOUSE_DATABASE", "logs")
	user := getEnv("CLICKHOUSE_USER", "default")
	password := getEnv("CLICKHOUSE_PASSWORD", "")
	resendAPIKey := os.Getenv("RESEND_API_KEY")
	fromEmail := getEnv("ALERT_FROM_EMAIL", "alerts@yourdomain.com")

	if resendAPIKey == "" {
		log.Fatal("RESEND_API_KEY environment variable is required")
	}

	// Connect to ClickHouse
	var conn driver.Conn
	var err error
	for i := 0; i < 30; i++ {
		conn, err = clickhouse.Open(&clickhouse.Options{
			Addr: []string{fmt.Sprintf("%s:%s", host, port)},
			Auth: clickhouse.Auth{
				Database: database,
				Username: user,
				Password: password,
			},
			Settings: clickhouse.Settings{
				"max_execution_time": 60,
			},
			DialTimeout:     10 * time.Second,
			MaxOpenConns:    5,
			MaxIdleConns:    2,
			ConnMaxLifetime: time.Hour,
		})
		if err == nil {
			if err = conn.Ping(context.Background()); err == nil {
				break
			}
		}
		log.Printf("Waiting for ClickHouse... (%d/30): %v", i+1, err)
		time.Sleep(2 * time.Second)
	}

	if err != nil {
		log.Fatalf("Failed to connect to ClickHouse: %v", err)
	}

	log.Println("Connected to ClickHouse, starting alert worker...")

	// Initialize state map for tracking last run times
	state := make(map[string]*AlertState)

	// Main loop
	for {
		// Fetch alerts from database each iteration (enables hot-reload)
		alerts, err := fetchAlertsFromDB(conn)
		if err != nil {
			log.Printf("Error fetching alerts from database: %v", err)
			time.Sleep(10 * time.Second)
			continue
		}

		for _, alert := range alerts {
			// Initialize state for new alerts
			if state[alert.ID] == nil {
				state[alert.ID] = &AlertState{}
			}
			s := state[alert.ID]
			now := time.Now()

			// Check interval
			if now.Sub(s.LastRun) < time.Duration(alert.IntervalSeconds)*time.Second {
				continue
			}

			s.LastRun = now

			// Execute query
			result, err := executeQuery(conn, alert.Query)
			if err != nil {
				log.Printf("[%s] Query error: %v", alert.ID, err)
				continue
			}

			// Evaluate condition
			triggered, err := evaluateCondition(alert.Condition, result)
			if err != nil {
				log.Printf("[%s] Condition evaluation error: %v", alert.ID, err)
				continue
			}

			if !triggered {
				continue
			}

			// Check cooldown using last_triggered_at from database
			if now.Sub(alert.LastTriggeredAt) < time.Duration(alert.CooldownSeconds)*time.Second {
				log.Printf("[%s] Alert triggered but in cooldown (last triggered: %v)", alert.ID, alert.LastTriggeredAt)
				continue
			}

			// Send alert
			log.Printf("[%s] Sending alert: %s", alert.ID, alert.Name)
			body := formatAlertBody(alert, result)

			for _, recipient := range alert.Recipients {
				if err := sendEmail(resendAPIKey, fromEmail, recipient, alert.Subject, body); err != nil {
					log.Printf("[%s] Failed to send email to %s: %v", alert.ID, recipient, err)
				} else {
					log.Printf("[%s] Email sent to %s", alert.ID, recipient)
				}
			}

			// Update last_triggered_at in database
			if err := updateLastTriggered(conn, alert.ID); err != nil {
				log.Printf("[%s] Failed to update last_triggered_at: %v", alert.ID, err)
			}
		}

		time.Sleep(time.Second)
	}
}

func fetchAlertsFromDB(conn driver.Conn) ([]Alert, error) {
	query := `
		SELECT
			toString(id) as id,
			name,
			description,
			query,
			condition,
			interval_seconds,
			cooldown_seconds,
			recipients,
			subject,
			last_triggered_at
		FROM logs.alerts
		WHERE enabled = 1
	`

	rows, err := conn.Query(context.Background(), query)
	if err != nil {
		return nil, fmt.Errorf("failed to query alerts: %w", err)
	}
	defer rows.Close()

	var alerts []Alert
	for rows.Next() {
		var (
			id              string
			name            string
			description     string
			alertQuery      string
			condition       string
			intervalSeconds uint32
			cooldownSeconds uint32
			recipientsJSON  string
			subject         string
			lastTriggeredAt time.Time
		)

		if err := rows.Scan(&id, &name, &description, &alertQuery, &condition,
			&intervalSeconds, &cooldownSeconds, &recipientsJSON, &subject, &lastTriggeredAt); err != nil {
			return nil, fmt.Errorf("failed to scan alert row: %w", err)
		}

		// Parse recipients JSON
		var recipients []string
		if err := json.Unmarshal([]byte(recipientsJSON), &recipients); err != nil {
			log.Printf("Warning: Failed to parse recipients for alert %s: %v", id, err)
			recipients = []string{}
		}

		// Enforce minimum interval
		if intervalSeconds < 30 {
			intervalSeconds = 30
		}

		alerts = append(alerts, Alert{
			ID:              id,
			Name:            name,
			Description:     description,
			Query:           alertQuery,
			Condition:       condition,
			IntervalSeconds: int(intervalSeconds),
			CooldownSeconds: int(cooldownSeconds),
			Recipients:      recipients,
			Subject:         subject,
			LastTriggeredAt: lastTriggeredAt,
		})
	}

	return alerts, nil
}

func updateLastTriggered(conn driver.Conn, alertID string) error {
	query := fmt.Sprintf(`
		ALTER TABLE logs.alerts
		UPDATE last_triggered_at = now()
		WHERE id = '%s'
	`, alertID)

	return conn.Exec(context.Background(), query)
}

func executeQuery(conn driver.Conn, query string) (map[string]interface{}, error) {
	rows, err := conn.Query(context.Background(), query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	if !rows.Next() {
		return nil, fmt.Errorf("query returned no rows")
	}

	// Get column info
	columnTypes := rows.ColumnTypes()
	values := make([]interface{}, len(columnTypes))

	// Allocate concrete typed values based on ClickHouse column types
	for i, col := range columnTypes {
		dbType := col.DatabaseTypeName()
		switch {
		case strings.HasPrefix(dbType, "UInt64"):
			values[i] = new(uint64)
		case strings.HasPrefix(dbType, "UInt32"):
			values[i] = new(uint32)
		case strings.HasPrefix(dbType, "UInt16"):
			values[i] = new(uint16)
		case strings.HasPrefix(dbType, "UInt8"):
			values[i] = new(uint8)
		case strings.HasPrefix(dbType, "Int64"):
			values[i] = new(int64)
		case strings.HasPrefix(dbType, "Int32"):
			values[i] = new(int32)
		case strings.HasPrefix(dbType, "Int16"):
			values[i] = new(int16)
		case strings.HasPrefix(dbType, "Int8"):
			values[i] = new(int8)
		case strings.HasPrefix(dbType, "Float64"):
			values[i] = new(float64)
		case strings.HasPrefix(dbType, "Float32"):
			values[i] = new(float32)
		case strings.HasPrefix(dbType, "String"), strings.HasPrefix(dbType, "FixedString"):
			values[i] = new(string)
		case strings.HasPrefix(dbType, "DateTime"):
			values[i] = new(time.Time)
		case strings.HasPrefix(dbType, "Date"):
			values[i] = new(time.Time)
		default:
			// Fallback for other types - try string
			values[i] = new(string)
		}
	}

	if err := rows.Scan(values...); err != nil {
		return nil, err
	}

	// Dereference pointers and build result map
	result := make(map[string]interface{})
	for i, col := range columnTypes {
		// Dereference the pointer to get the actual value
		switch v := values[i].(type) {
		case *uint64:
			result[col.Name()] = *v
		case *uint32:
			result[col.Name()] = *v
		case *uint16:
			result[col.Name()] = *v
		case *uint8:
			result[col.Name()] = *v
		case *int64:
			result[col.Name()] = *v
		case *int32:
			result[col.Name()] = *v
		case *int16:
			result[col.Name()] = *v
		case *int8:
			result[col.Name()] = *v
		case *float64:
			result[col.Name()] = *v
		case *float32:
			result[col.Name()] = *v
		case *string:
			result[col.Name()] = *v
		case *time.Time:
			result[col.Name()] = *v
		default:
			result[col.Name()] = v
		}
	}

	return result, nil
}

func evaluateCondition(condition string, result map[string]interface{}) (bool, error) {
	// Simple expression evaluator for conditions like:
	// - "cnt > 50"
	// - "cnt == 0"
	// - "errors >= 10 && total > 100"

	condition = strings.TrimSpace(condition)

	// Handle && (AND)
	if strings.Contains(condition, "&&") {
		parts := strings.SplitN(condition, "&&", 2)
		left, err := evaluateCondition(parts[0], result)
		if err != nil {
			return false, err
		}
		right, err := evaluateCondition(parts[1], result)
		if err != nil {
			return false, err
		}
		return left && right, nil
	}

	// Handle || (OR)
	if strings.Contains(condition, "||") {
		parts := strings.SplitN(condition, "||", 2)
		left, err := evaluateCondition(parts[0], result)
		if err != nil {
			return false, err
		}
		right, err := evaluateCondition(parts[1], result)
		if err != nil {
			return false, err
		}
		return left || right, nil
	}

	// Parse simple comparison
	operators := []string{">=", "<=", "!=", "==", ">", "<"}
	for _, op := range operators {
		if strings.Contains(condition, op) {
			parts := strings.SplitN(condition, op, 2)
			if len(parts) != 2 {
				continue
			}

			varName := strings.TrimSpace(parts[0])
			valueStr := strings.TrimSpace(parts[1])

			varValue, ok := result[varName]
			if !ok {
				return false, fmt.Errorf("variable %s not found in result", varName)
			}

			// Convert to float64 for comparison
			var varNum float64
			switch v := varValue.(type) {
			case int64:
				varNum = float64(v)
			case uint64:
				varNum = float64(v)
			case float64:
				varNum = v
			case int:
				varNum = float64(v)
			default:
				return false, fmt.Errorf("cannot convert %s (type %T) to number", varName, varValue)
			}

			compareNum, err := strconv.ParseFloat(valueStr, 64)
			if err != nil {
				return false, fmt.Errorf("cannot parse comparison value: %s", valueStr)
			}

			switch op {
			case ">":
				return varNum > compareNum, nil
			case "<":
				return varNum < compareNum, nil
			case ">=":
				return varNum >= compareNum, nil
			case "<=":
				return varNum <= compareNum, nil
			case "==":
				return varNum == compareNum, nil
			case "!=":
				return varNum != compareNum, nil
			}
		}
	}

	return false, fmt.Errorf("could not parse condition: %s", condition)
}

func formatAlertBody(alert Alert, result map[string]interface{}) string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("Alert: %s\n", alert.Name))
	sb.WriteString(fmt.Sprintf("Time: %s\n", time.Now().Format(time.RFC3339)))
	sb.WriteString(fmt.Sprintf("Description: %s\n\n", alert.Description))

	sb.WriteString("Query Result:\n")
	for k, v := range result {
		sb.WriteString(fmt.Sprintf("  %s: %v\n", k, v))
	}

	sb.WriteString(fmt.Sprintf("\nQuery:\n%s\n", alert.Query))

	return sb.String()
}

func sendEmail(apiKey, from, to, subject, body string) error {
	payload := map[string]interface{}{
		"from":    from,
		"to":      []string{to},
		"subject": subject,
		"text":    body,
	}

	jsonBody, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", "https://api.resend.com/emails", bytes.NewBuffer(jsonBody))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("resend error (status %d): %s", resp.StatusCode, respBody)
	}

	return nil
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
