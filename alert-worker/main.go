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
	DestinationIDs  []string  `json:"destination_ids"`
	Subject         string    `json:"subject"`
	LastTriggeredAt time.Time `json:"last_triggered_at"`
}

type AlertState struct {
	LastRun time.Time
}

type Destination struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Config  string `json:"config"`
	Enabled uint8  `json:"enabled"`
}

type EmailConfig struct {
	Email string `json:"email"`
	From  string `json:"from"`
}

type WebhookConfig struct {
	URL            string            `json:"url"`
	Method         string            `json:"method"`
	Headers        map[string]string `json:"headers"`
	TimeoutSeconds int               `json:"timeout_seconds"`
}

type WebhookPayload struct {
	AlertID     string                 `json:"alert_id"`
	AlertName   string                 `json:"alert_name"`
	Description string                 `json:"description"`
	Query       string                 `json:"query"`
	Condition   string                 `json:"condition"`
	TriggeredAt string                 `json:"triggered_at"`
	QueryResult map[string]interface{} `json:"query_result"`
}

func main() {
	host := getEnv("CLICKHOUSE_HOST", "clickhouse")
	port := getEnv("CLICKHOUSE_PORT", "9000")
	database := getEnv("CLICKHOUSE_DATABASE", "logs")
	user := getEnv("CLICKHOUSE_USER", "default")
	password := getEnv("CLICKHOUSE_PASSWORD", "")
	resendAPIKey := os.Getenv("RESEND_API_KEY")
	fromEmail := getEnv("ALERT_FROM_EMAIL", "alerts@yourdomain.com")
	dashboardURL := getEnv("DASHBOARD_URL", "https://logs.redleg.dev")

	if resendAPIKey == "" {
		log.Println("Warning: RESEND_API_KEY not set - email destinations will not work")
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
			dispatchAlert(conn, alert, result, resendAPIKey, fromEmail, dashboardURL)

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
			destination_ids,
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
			id                 string
			name               string
			description        string
			alertQuery         string
			condition          string
			intervalSeconds    uint32
			cooldownSeconds    uint32
			recipientsJSON     string
			destinationIDsJSON string
			subject            string
			lastTriggeredAt    time.Time
		)

		if err := rows.Scan(&id, &name, &description, &alertQuery, &condition,
			&intervalSeconds, &cooldownSeconds, &recipientsJSON, &destinationIDsJSON, &subject, &lastTriggeredAt); err != nil {
			return nil, fmt.Errorf("failed to scan alert row: %w", err)
		}

		// Parse recipients JSON
		var recipients []string
		if err := json.Unmarshal([]byte(recipientsJSON), &recipients); err != nil {
			log.Printf("Warning: Failed to parse recipients for alert %s: %v", id, err)
			recipients = []string{}
		}

		// Parse destination_ids JSON
		var destinationIDs []string
		if err := json.Unmarshal([]byte(destinationIDsJSON), &destinationIDs); err != nil {
			log.Printf("Warning: Failed to parse destination_ids for alert %s: %v", id, err)
			destinationIDs = []string{}
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
			DestinationIDs:  destinationIDs,
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

func formatAlertBody(alert Alert, result map[string]interface{}, dashboardURL string) (string, string) {
	// Plain text version
	var text strings.Builder
	text.WriteString(fmt.Sprintf("Alert: %s\n", alert.Name))
	text.WriteString(fmt.Sprintf("Time: %s\n", time.Now().Format(time.RFC3339)))
	text.WriteString(fmt.Sprintf("Description: %s\n\n", alert.Description))
	text.WriteString("Query Result:\n")
	for k, v := range result {
		text.WriteString(fmt.Sprintf("  %s: %v\n", k, v))
	}
	text.WriteString(fmt.Sprintf("\nQuery:\n%s\n", alert.Query))
	text.WriteString(fmt.Sprintf("\nView in Log Cannon: %s/alerts\n", dashboardURL))

	// HTML version
	alertURL := fmt.Sprintf("%s/alerts", dashboardURL)
	logsURL := fmt.Sprintf("%s/", dashboardURL)
	triggeredTime := time.Now().Format("Jan 2, 2006 at 3:04 PM MST")

	// Build query results HTML
	var resultsHTML strings.Builder
	for k, v := range result {
		resultsHTML.WriteString(fmt.Sprintf(`
			<tr>
				<td style="padding: 8px 12px; border-bottom: 1px solid #2a2a2e; color: #a0a0a5; font-family: 'JetBrains Mono', Monaco, 'Courier New', monospace; font-size: 13px;">%s</td>
				<td style="padding: 8px 12px; border-bottom: 1px solid #2a2a2e; color: #ffffff; font-family: 'JetBrains Mono', Monaco, 'Courier New', monospace; font-size: 13px; font-weight: 600;">%v</td>
			</tr>`, escapeHTML(k), v))
	}

	html := fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>%s</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
	<table role="presentation" style="width: 100%%; border-collapse: collapse;">
		<tr>
			<td align="center" style="padding: 40px 20px;">
				<table role="presentation" style="width: 100%%; max-width: 600px; border-collapse: collapse;">
					<!-- Header -->
					<tr>
						<td style="padding: 24px 32px; background: linear-gradient(135deg, #141416 0%%, #1a1a1e 100%%); border-radius: 12px 12px 0 0; border-bottom: 2px solid #FF4D2A;">
							<table role="presentation" style="width: 100%%;">
								<tr>
									<td>
										<img src="https://logs.redleg.dev/icons/icon.svg" width="32" height="32" alt="Log Cannon" style="vertical-align: middle;">
										<span style="margin-left: 12px; font-size: 18px; font-weight: 700; color: #ffffff; vertical-align: middle;">LOG <span style="color: #FF4D2A;">CANNON</span></span>
									</td>
									<td align="right">
										<span style="display: inline-block; padding: 6px 12px; background-color: rgba(255, 77, 42, 0.15); border: 1px solid #FF4D2A; border-radius: 6px; color: #FF4D2A; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Alert Triggered</span>
									</td>
								</tr>
							</table>
						</td>
					</tr>

					<!-- Main Content -->
					<tr>
						<td style="padding: 32px; background-color: #141416;">
							<!-- Alert Name -->
							<h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #ffffff;">%s</h1>
							<p style="margin: 0 0 24px 0; font-size: 14px; color: #a0a0a5;">%s</p>

							<!-- Triggered Time -->
							<table role="presentation" style="width: 100%%; margin-bottom: 24px;">
								<tr>
									<td style="padding: 16px; background-color: #1a1a1e; border-radius: 8px; border-left: 3px solid #FF4D2A;">
										<p style="margin: 0 0 4px 0; font-size: 12px; color: #a0a0a5; text-transform: uppercase; letter-spacing: 0.5px;">Triggered</p>
										<p style="margin: 0; font-size: 16px; color: #ffffff; font-weight: 500;">%s</p>
									</td>
								</tr>
							</table>

							<!-- Query Results -->
							<h2 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #a0a0a5; text-transform: uppercase; letter-spacing: 0.5px;">Query Results</h2>
							<table role="presentation" style="width: 100%%; border-collapse: collapse; background-color: #1a1a1e; border-radius: 8px; overflow: hidden; margin-bottom: 24px;">
								<tr>
									<th style="padding: 10px 12px; text-align: left; background-color: #222226; color: #a0a0a5; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Field</th>
									<th style="padding: 10px 12px; text-align: left; background-color: #222226; color: #a0a0a5; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Value</th>
								</tr>
								%s
							</table>

							<!-- Query -->
							<h2 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #a0a0a5; text-transform: uppercase; letter-spacing: 0.5px;">Query</h2>
							<div style="padding: 16px; background-color: #0a0a0b; border-radius: 8px; border: 1px solid #2a2a2e; margin-bottom: 24px;">
								<code style="font-family: 'JetBrains Mono', Monaco, 'Courier New', monospace; font-size: 12px; color: #e0e0e5; white-space: pre-wrap; word-break: break-all;">%s</code>
							</div>

							<!-- Action Buttons -->
							<table role="presentation" style="width: 100%%;">
								<tr>
									<td style="padding-right: 8px;">
										<a href="%s" style="display: block; padding: 14px 24px; background-color: #FF4D2A; color: #ffffff; text-decoration: none; text-align: center; font-weight: 600; font-size: 14px; border-radius: 8px;">View Alert Settings</a>
									</td>
									<td style="padding-left: 8px;">
										<a href="%s" style="display: block; padding: 14px 24px; background-color: #1a1a1e; color: #ffffff; text-decoration: none; text-align: center; font-weight: 600; font-size: 14px; border-radius: 8px; border: 1px solid #2a2a2e;">Search Logs</a>
									</td>
								</tr>
							</table>
						</td>
					</tr>

					<!-- Footer -->
					<tr>
						<td style="padding: 24px 32px; background-color: #0e0e10; border-radius: 0 0 12px 12px; border-top: 1px solid #2a2a2e;">
							<p style="margin: 0; font-size: 12px; color: #6b6b70; text-align: center;">
								This alert was sent by <a href="%s" style="color: #FF4D2A; text-decoration: none;">Log Cannon</a>.
								<br>Manage your alerts at <a href="%s" style="color: #FF4D2A; text-decoration: none;">%s/alerts</a>
							</p>
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
</body>
</html>`,
		escapeHTML(alert.Subject),
		escapeHTML(alert.Name),
		escapeHTML(alert.Description),
		triggeredTime,
		resultsHTML.String(),
		escapeHTML(alert.Query),
		alertURL,
		logsURL,
		dashboardURL,
		alertURL,
		dashboardURL,
	)

	return text.String(), html
}

func escapeHTML(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "'", "&#39;")
	return s
}

func sendEmail(apiKey, from, to, subject, textBody, htmlBody string) error {
	payload := map[string]interface{}{
		"from":    from,
		"to":      []string{to},
		"subject": subject,
		"text":    textBody,
		"html":    htmlBody,
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

func fetchDestinationsByIDs(conn driver.Conn, ids []string) ([]Destination, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	quoted := make([]string, len(ids))
	for i, id := range ids {
		quoted[i] = fmt.Sprintf("'%s'", id)
	}
	query := fmt.Sprintf(`
		SELECT toString(id) as id, name, type, config, enabled
		FROM logs.alert_destinations
		WHERE id IN (%s) AND enabled = 1
	`, strings.Join(quoted, ","))

	rows, err := conn.Query(context.Background(), query)
	if err != nil {
		return nil, fmt.Errorf("failed to query destinations: %w", err)
	}
	defer rows.Close()

	var destinations []Destination
	for rows.Next() {
		var d Destination
		if err := rows.Scan(&d.ID, &d.Name, &d.Type, &d.Config, &d.Enabled); err != nil {
			return nil, fmt.Errorf("failed to scan destination row: %w", err)
		}
		destinations = append(destinations, d)
	}
	return destinations, nil
}

func sendWebhook(cfg WebhookConfig, payload WebhookPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	method := cfg.Method
	if method == "" {
		method = "POST"
	}
	timeout := cfg.TimeoutSeconds
	if timeout <= 0 {
		timeout = 10
	}
	client := &http.Client{Timeout: time.Duration(timeout) * time.Second}
	req, err := http.NewRequest(method, cfg.URL, bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range cfg.Headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("webhook error (status %d): %s", resp.StatusCode, respBody)
	}
	return nil
}

func dispatchAlert(conn driver.Conn, alert Alert, result map[string]interface{},
	resendAPIKey, fromEmail, dashboardURL string) {

	textBody, htmlBody := formatAlertBody(alert, result, dashboardURL)

	// New destinations path
	if len(alert.DestinationIDs) > 0 {
		destinations, err := fetchDestinationsByIDs(conn, alert.DestinationIDs)
		if err != nil {
			log.Printf("[%s] Failed to fetch destinations: %v", alert.ID, err)
		}
		for _, dest := range destinations {
			switch dest.Type {
			case "email":
				var cfg EmailConfig
				if err := json.Unmarshal([]byte(dest.Config), &cfg); err != nil {
					log.Printf("[%s] Bad email config for dest %s: %v", alert.ID, dest.ID, err)
					continue
				}
				from := fromEmail
				if cfg.From != "" {
					from = cfg.From
				}
				if resendAPIKey == "" {
					log.Printf("[%s] Cannot send email to %s: RESEND_API_KEY not set", alert.ID, cfg.Email)
					continue
				}
				if err := sendEmail(resendAPIKey, from, cfg.Email, alert.Subject, textBody, htmlBody); err != nil {
					log.Printf("[%s] Email to %s failed: %v", alert.ID, cfg.Email, err)
				} else {
					log.Printf("[%s] Email sent to %s via dest %s", alert.ID, cfg.Email, dest.Name)
				}
			case "webhook":
				var cfg WebhookConfig
				if err := json.Unmarshal([]byte(dest.Config), &cfg); err != nil {
					log.Printf("[%s] Bad webhook config for dest %s: %v", alert.ID, dest.ID, err)
					continue
				}
				payload := WebhookPayload{
					AlertID:     alert.ID,
					AlertName:   alert.Name,
					Description: alert.Description,
					Query:       alert.Query,
					Condition:   alert.Condition,
					TriggeredAt: time.Now().UTC().Format(time.RFC3339),
					QueryResult: result,
				}
				if err := sendWebhook(cfg, payload); err != nil {
					log.Printf("[%s] Webhook to %s failed: %v", alert.ID, cfg.URL, err)
				} else {
					log.Printf("[%s] Webhook sent to %s via dest %s", alert.ID, cfg.URL, dest.Name)
				}
			default:
				log.Printf("[%s] Unknown destination type: %s", alert.ID, dest.Type)
			}
		}
		return
	}

	// Legacy recipients fallback
	for _, recipient := range alert.Recipients {
		if resendAPIKey == "" {
			log.Printf("[%s] Cannot send email to %s: RESEND_API_KEY not set", alert.ID, recipient)
			continue
		}
		if err := sendEmail(resendAPIKey, fromEmail, recipient, alert.Subject, textBody, htmlBody); err != nil {
			log.Printf("[%s] Failed to send email to %s: %v", alert.ID, recipient, err)
		} else {
			log.Printf("[%s] Email sent to %s", alert.ID, recipient)
		}
	}
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
