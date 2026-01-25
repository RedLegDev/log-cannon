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

type AlertConfig struct {
	Alerts []Alert `json:"alerts"`
}

type Alert struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	Query           string   `json:"query"`
	Condition       string   `json:"condition"`
	IntervalSeconds int      `json:"interval_seconds"`
	CooldownSeconds int      `json:"cooldown_seconds"`
	Recipients      []string `json:"recipients"`
	Subject         string   `json:"subject"`
}

type AlertState struct {
	LastRun       time.Time
	LastTriggered time.Time
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

	// Load alerts config
	alertConfig, err := loadAlerts("/app/alerts.json")
	if err != nil {
		log.Printf("Warning: Failed to load alerts.json: %v", err)
		alertConfig = &AlertConfig{Alerts: []Alert{}}
	}

	log.Printf("Loaded %d alerts", len(alertConfig.Alerts))

	// Connect to ClickHouse
	var conn driver.Conn
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

	// Initialize state
	state := make(map[string]*AlertState)
	for _, alert := range alertConfig.Alerts {
		state[alert.ID] = &AlertState{}
	}

	// Main loop
	for {
		for _, alert := range alertConfig.Alerts {
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

			// Check cooldown
			if now.Sub(s.LastTriggered) < time.Duration(alert.CooldownSeconds)*time.Second {
				log.Printf("[%s] Alert triggered but in cooldown", alert.ID)
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

			s.LastTriggered = now
		}

		time.Sleep(time.Second)
	}
}

func loadAlerts(path string) (*AlertConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var config AlertConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	// Validate alerts
	for i, alert := range config.Alerts {
		if alert.IntervalSeconds < 30 {
			config.Alerts[i].IntervalSeconds = 30
		}
	}

	return &config, nil
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
	valuePtrs := make([]interface{}, len(columnTypes))

	for i := range columnTypes {
		valuePtrs[i] = &values[i]
	}

	if err := rows.Scan(valuePtrs...); err != nil {
		return nil, err
	}

	result := make(map[string]interface{})
	for i, col := range columnTypes {
		result[col.Name()] = values[i]
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
