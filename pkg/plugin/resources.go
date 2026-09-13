package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// testConnectionRequest allows the config UI to probe draft (unsaved) settings.
type testConnectionRequest struct {
	APIURL string `json:"apiUrl"`
	APIKey string `json:"apiKey"`
}

// testConnectionResponse is returned by POST /test-connection.
type testConnectionResponse struct {
	Status         string `json:"status"`
	Message        string `json:"message"`
	Connected      *bool  `json:"connected,omitempty"`
	UpstreamStatus int    `json:"upstreamStatus,omitempty"`
	Path           string `json:"path,omitempty"`
}

// toolProxyResponse is the stable resource envelope for /query and /remediate.
// ok is true iff the upstream (or local) status is 2xx.
type toolProxyResponse struct {
	OK      bool   `json:"ok"`
	Status  int    `json:"status"`
	Summary string `json:"summary"`
	Error   string `json:"error"`
}

func classifyTransportError(prefix string, err error) string {
	if err == nil {
		return prefix
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "context deadline exceeded") || strings.Contains(msg, "timeout") || strings.Contains(msg, "timed out"):
		return prefix + ": timeout"
	case strings.Contains(msg, "connection refused"):
		return prefix + ": connection refused"
	case strings.Contains(msg, "connection reset"):
		return prefix + ": connection reset"
	default:
		return prefix
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeToolProxy(w http.ResponseWriter, httpStatus int, status int, summary, errMsg string) {
	writeJSON(w, httpStatus, toolProxyResponse{
		OK:      status >= 200 && status < 300,
		Status:  status,
		Summary: summary,
		Error:   errMsg,
	})
}

// Ask log: one JSON line per query/remediate on the Grafana data PVC.
// Never includes Authorization headers or apiKey values.
const (
	defaultAskLogPath = "/var/lib/grafana/dotai-ask.log"
	maxAskLogBytes    = 1 << 20 // 1 MiB; rotate before append when exceeded
)

var (
	askLogPath = defaultAskLogPath
	askLogMu   sync.Mutex
)

type askLogEntry struct {
	Time         string `json:"time"`
	Tool         string `json:"tool"`
	Body         string `json:"body"`
	Status       int    `json:"status"`
	Summary      string `json:"summary,omitempty"`
	Error        string `json:"error,omitempty"`
	Hop          int    `json:"hop,omitempty"`
	Hops         int    `json:"hops,omitempty"`
	CurrentEmpty *bool  `json:"current_empty,omitempty"`
	FirstHop     string `json:"first_hop,omitempty"`
	Branch       string `json:"branch,omitempty"`
	// Login is the Grafana user login. When the request has no user (health
	// checks, background calls), it is the explicit marker "unauthenticated".
	// Email is intentionally omitted (PII).
	Login string `json:"login"`
	Role  string `json:"role,omitempty"`
}

// askLogUnauthenticated is written to askLogEntry.Login when PluginContext.User is nil.
const askLogUnauthenticated = "unauthenticated"

// userAttribution returns Login and Role for ask-log entries. Nil user is safe.
func userAttribution(ctx context.Context) (login, role string) {
	u := backend.UserFromContext(ctx)
	if u == nil {
		return askLogUnauthenticated, ""
	}
	return u.Login, u.Role
}

func toolNameFromPath(toolPath string) string {
	switch toolPath {
	case "/api/v1/tools/query":
		return "query"
	case "/api/v1/tools/remediate":
		return "remediate"
	default:
		return strings.TrimPrefix(toolPath, "/api/v1/tools/")
	}
}

func truncateRunes(s string, max int) string {
	if max <= 0 || s == "" {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// truncateRunesKeepTail caps s at max runes while preserving the last tail runes.
// Progressive-context bodies pack the Current block first and the question last, so a
// head-only truncation silently drops the follow-up prompt — which is exactly the text
// that identifies which hop branch fired. Elision is marked with the omitted rune count.
func truncateRunesKeepTail(s string, max, tail int) string {
	if max <= 0 || s == "" {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	if tail <= 0 || tail >= max {
		return string(r[:max]) + "…"
	}
	head := max - tail
	return string(r[:head]) + fmt.Sprintf("…[+%d]…", len(r)-max) + string(r[len(r)-tail:])
}

// askBodyPreview extracts a truncated intent/issue for the log line.
// Sensitive JSON keys are stripped; Authorization/apiKey never appear.
// The cap must hold a progressive-context question (Current state block +
// the user question) intact so ask-log measures can score used_current.
// The question is packed AFTER Current, so the tail is preserved explicitly.
func askBodyPreview(body []byte) string {
	const (
		max  = 4096
		tail = 1024
	)
	if len(body) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return truncateRunesKeepTail(string(body), max, tail)
	}
	for _, k := range []string{
		"apiKey", "apikey", "api_key",
		"authorization", "Authorization",
		"token", "authToken", "password", "secret",
		"hop", "hops", "current_empty", "first_hop", "branch",
	} {
		delete(m, k)
	}
	for _, k := range []string{"intent", "issue"} {
		if s := trimmedStringAt(m, k); s != "" {
			return truncateRunesKeepTail(s, max, tail)
		}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return ""
	}
	return truncateRunesKeepTail(string(b), max, tail)
}

// askMetaFromBody pulls optional orchestration fields for the ask log.
func askMetaFromBody(body []byte) (hop, hops int, currentEmpty *bool, firstHop, branch string) {
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil || m == nil {
		return 0, 0, nil, "", ""
	}
	hop = intFromAny(m["hop"])
	hops = intFromAny(m["hops"])
	if v, ok := m["current_empty"]; ok {
		if b, ok := v.(bool); ok {
			currentEmpty = &b
		}
	}
	if s, ok := m["first_hop"].(string); ok {
		s = strings.TrimSpace(s)
		if s == "grafana" || s == "dot-ai" {
			firstHop = s
		}
	}
	// Which follow-up branch produced this POST; makes hop attribution deterministic
	// instead of inferred from hop counts and truncated prompt text.
	if s, ok := m["branch"].(string); ok {
		switch s = strings.TrimSpace(s); s {
		case "initial", "across", "conflict", "hedge", "refine":
			branch = s
		}
	}
	return hop, hops, currentEmpty, firstHop, branch
}

func intFromAny(v any) int {
	switch n := v.(type) {
	case float64:
		if n > 0 {
			return int(n)
		}
	case int:
		if n > 0 {
			return n
		}
	case int64:
		if n > 0 {
			return int(n)
		}
	case json.Number:
		i, err := n.Int64()
		if err == nil && i > 0 {
			return int(i)
		}
	}
	return 0
}

// stripAskMetaForUpstream allowlists fields before dot-ai (query and remediate).
func stripAskMetaForUpstream(body []byte, toolPath string) ([]byte, error) {
	if toolPath == "/api/v1/tools/remediate" {
		return sanitizeRemediateBody(body)
	}
	return sanitizeQueryBody(body)
}

// sanitizeQueryBody allowlists analysis-only query fields. Hop meta and any
// extra keys (including execute/apply) are dropped so query matches remediate
// "allowlisted by construction".
func sanitizeQueryBody(body []byte) ([]byte, error) {
	var in map[string]any
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, fmt.Errorf("invalid JSON body")
	}
	intent, _ := in["intent"].(string)
	if strings.TrimSpace(intent) == "" {
		return nil, fmt.Errorf("intent is required")
	}
	return json.Marshal(map[string]any{"intent": intent})
}

// appendAskLog writes one JSON line for a completed query/remediate call.
// Best-effort: failures to write must not affect the HTTP response.
// When the log exceeds maxAskLogBytes, it is rotated to path+".1" (replacing any prior .1).
// User attribution (login + role) is taken from ctx; nil user → login "unauthenticated".
func appendAskLog(ctx context.Context, tool string, body []byte, status int, summary, errMsg string) {
	path := askLogPath
	if path == "" {
		return
	}
	hop, hops, currentEmpty, firstHop, branch := askMetaFromBody(body)
	login, role := userAttribution(ctx)
	entry := askLogEntry{
		Time:         time.Now().UTC().Format(time.RFC3339),
		Tool:         tool,
		Body:         askBodyPreview(body),
		Status:       status,
		Summary:      truncateRunes(summary, 512),
		Error:        truncateRunes(errMsg, 512),
		Hop:          hop,
		Hops:         hops,
		CurrentEmpty: currentEmpty,
		FirstHop:     firstHop,
		Branch:       branch,
		Login:        login,
		Role:         role,
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	line = append(line, '\n')

	askLogMu.Lock()
	defer askLogMu.Unlock()

	if info, err := os.Stat(path); err == nil && info.Size() >= maxAskLogBytes {
		rotated := path + ".1"
		_ = os.Remove(rotated)
		if err := os.Rename(path, rotated); err != nil {
			_ = os.Truncate(path, 0)
		}
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = f.Write(line)
}



// handleHealth is the plugin resource health probe.
// When configured, it calls dot-ai version (same path as Test connection).
func (a *App) handleHealth(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if a.apiURL == "" || a.apiKey == "" {
		writeJSON(w, http.StatusOK, testConnectionResponse{
			Status:  "not_configured",
			Message: "set MCP Server URL (apiUrl) and Auth Token, then use Test connection",
			Path:    "/health",
		})
		return
	}

	result, code := a.probeVersion(req.Context(), a.apiURL, a.apiKey)
	result.Path = "/health"
	writeJSON(w, code, result)
}

// handleTestConnection POSTs to dot-ai /api/v1/tools/version with Bearer auth.
func (a *App) handleTestConnection(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Configuration is Admin-only; Test connection must not let a Viewer probe
	// the saved URL with a token they supply.
	if !isOrgAdmin(req.Context()) {
		writeJSON(w, http.StatusForbidden, testConnectionResponse{
			Status:  "error",
			Message: "Admin role required to test connection",
		})
		return
	}

	apiURL := a.apiURL
	apiKey := a.apiKey

	if req.Body != nil {
		defer func() { _ = req.Body.Close() }()
		var body testConnectionRequest
		dec := json.NewDecoder(req.Body)
		if err := dec.Decode(&body); err != nil && err != io.EOF {
			writeJSON(w, http.StatusBadRequest, testConnectionResponse{
				Status:  "error",
				Message: "invalid JSON body",
			})
			return
		}
		bodyURL := strings.TrimRight(strings.TrimSpace(body.APIURL), "/")
		bodyKey := strings.TrimSpace(body.APIKey)

		if bodyURL != "" && bodyURL != a.apiURL {
			apiURL = bodyURL
			if bodyKey != "" {
				apiKey = bodyKey
			} else {
				// SEC-01: never reuse the saved key against a different (draft) URL.
				apiKey = ""
			}
		} else {
			if bodyURL != "" {
				apiURL = bodyURL
			}
			if bodyKey != "" {
				apiKey = bodyKey
			}
		}
	}

	if apiURL == "" || apiKey == "" {
		writeJSON(w, http.StatusBadRequest, testConnectionResponse{
			Status:  "error",
			Message: "apiUrl and auth token are required (save settings or pass draft values)",
		})
		return
	}

	result, code := a.probeVersion(req.Context(), apiURL, apiKey)
	result.Path = "/test-connection"
	writeJSON(w, code, result)
}

func (a *App) probeVersion(ctx context.Context, apiURL, apiKey string) (testConnectionResponse, int) {
	base, err := validateAPIURL(apiURL)
	if err != nil {
		return testConnectionResponse{
			Status:  "error",
			Message: err.Error(),
		}, http.StatusBadRequest
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, versionURL(base), strings.NewReader("{}"))
	if err != nil {
		return testConnectionResponse{
			Status:  "error",
			Message: fmt.Sprintf("build request: %v", err),
		}, http.StatusBadRequest
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Accept", "application/json")

	client := a.httpClient
	if client == nil {
		return testConnectionResponse{
			Status:  "error",
			Message: "HTTP client not configured",
		}, http.StatusInternalServerError
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		log.DefaultLogger.Error("dot-ai version probe transport error", "error", err)
		return testConnectionResponse{
			Status:  "error",
			Message: classifyTransportError("dot-ai unreachable", err),
		}, http.StatusBadGateway
	}
	defer func() { _ = resp.Body.Close() }()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Do not reflect raw upstream error bodies to the UI.
		// Never surface upstream 401/403 as Grafana resource auth failure —
		// that confuses the frontend into treating the Grafana session as expired.
		msg := fmt.Sprintf("dot-ai version returned HTTP %d", resp.StatusCode)
		return testConnectionResponse{
			Status:         "error",
			Message:        msg,
			UpstreamStatus: resp.StatusCode,
		}, http.StatusBadGateway
	}

	connected := extractConnected(raw)
	msg := "connected to dot-ai"
	switch {
	case connected == nil:
		// dot-ai responded, but its body didn't carry a recognizable `connected`
		// field/shape — do not claim cluster connectivity we haven't confirmed.
		msg = "connected to dot-ai (cluster connectivity unknown)"
	case !*connected:
		msg = "dot-ai responded but Kubernetes reports not connected"
	}

	return testConnectionResponse{
		Status:         "ok",
		Message:        msg,
		Connected:      connected,
		UpstreamStatus: resp.StatusCode,
	}, http.StatusOK
}

// validateAPIURL requires an absolute http(s) URL with a non-empty host.
// http is allowed only for loopback, RFC1918, or in-cluster DNS (https-except-cluster-local).
// It returns a trimmed base (no trailing slash) suitable for path join.
// Call before any outbound dial so file://, javascript:, and host-less values never hit the network.
func validateAPIURL(apiURL string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(apiURL), "/")
	if base == "" {
		return "", fmt.Errorf("apiUrl is required")
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("invalid apiUrl: %w", err)
	}
	if !u.IsAbs() {
		return "", fmt.Errorf("apiUrl must be an absolute http(s) URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("apiUrl scheme must be http or https")
	}
	if u.Host == "" {
		return "", fmt.Errorf("apiUrl must include a host")
	}
	if scheme == "http" && !allowPlainHTTPHost(u.Hostname()) {
		return "", fmt.Errorf("http apiUrl is only allowed for loopback, RFC1918, or in-cluster DNS; use https")
	}
	return base, nil
}

// allowPlainHTTPHost reports whether host may use plaintext http.
// Loopback, RFC1918/private IPs, and in-cluster DNS are allowed; public hosts require https.
func allowPlainHTTPHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "localhost" || h == "127.0.0.1" || h == "::1" {
		return true
	}
	if strings.HasSuffix(h, ".svc") || strings.Contains(h, ".svc.") || strings.HasSuffix(h, ".cluster.local") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate()
	}
	return false
}

func versionURL(apiURL string) string {
	base := strings.TrimRight(strings.TrimSpace(apiURL), "/")
	return base + "/api/v1/tools/version"
}

func extractConnected(raw []byte) *bool {
	// M0 shape: connected may appear at top-level, data, or data.result.
	var envelope map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil
	}
	if v, ok := boolAt(envelope, "connected"); ok {
		return &v
	}
	if data, ok := envelope["data"].(map[string]any); ok {
		if v, ok := boolAt(data, "connected"); ok {
			return &v
		}
		if result, ok := data["result"].(map[string]any); ok {
			if v, ok := boolAt(result, "connected"); ok {
				return &v
			}
		}
	}
	if result, ok := envelope["result"].(map[string]any); ok {
		if v, ok := boolAt(result, "connected"); ok {
			return &v
		}
	}
	return nil
}

func boolAt(m map[string]any, key string) (bool, bool) {
	v, ok := m[key]
	if !ok {
		return false, false
	}
	b, ok := v.(bool)
	return b, ok
}

// handleQuery proxies POST /query → dot-ai /api/v1/tools/query with Bearer auth.
// Requires Grafana org Editor or Admin. App resource routes are reachable by any
// signed-in user with app access because Grafana gates them on ActionAppAccess,
// not org role (grafana/pkg/api/api.go:401-402). plugin.json includes[].role is
// navigation visibility only, evaluated only for i.Type == "page"
// (grafana/pkg/middleware/auth.go:114-130). routes[].reqRole applies only to the
// datasource proxy (grafana/pkg/api/pluginproxy/ds_proxy.go:307-310). The handler
// check is therefore the only available control; Viewer, empty, unknown, and nil
// users are refused before any upstream dial.
func (a *App) handleQuery(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !isEditorOrAbove(req.Context()) {
		writeToolProxy(w, http.StatusForbidden, http.StatusForbidden, "", "Editor role required")
		return
	}
	a.proxyDotAI(w, req, "/api/v1/tools/query")
}

// handleRemediate proxies POST /remediate → analysis-only /api/v1/tools/remediate.
// Requires Grafana org Editor or Admin (same gate as /query).
func (a *App) handleRemediate(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !isEditorOrAbove(req.Context()) {
		writeToolProxy(w, http.StatusForbidden, http.StatusForbidden, "", "Editor role required")
		return
	}
	a.proxyDotAI(w, req, "/api/v1/tools/remediate")
}

// sanitizeRemediateBody allowlists analysis-only fields for dot-ai remediate.
// Frontend historically sent {intent}; upstream requires {issue}. Accept both,
// map bare intent → issue, and drop execute/apply/mode/confirmation tokens so
// direct POSTs cannot trigger execution.
// Empty issue after mapping returns an error and must not forward {}.
func sanitizeRemediateBody(body []byte) ([]byte, error) {
	var in map[string]any
	if err := json.Unmarshal(body, &in); err != nil {
		return nil, fmt.Errorf("invalid JSON body")
	}
	out := make(map[string]any, 2)
	intent, _ := in["intent"].(string)
	issue, _ := in["issue"].(string)
	if strings.TrimSpace(issue) == "" && strings.TrimSpace(intent) != "" {
		issue = intent
	}
	if strings.TrimSpace(issue) == "" {
		return nil, fmt.Errorf("issue is required")
	}
	if strings.TrimSpace(intent) != "" {
		out["intent"] = intent
	}
	out["issue"] = strings.TrimSpace(issue)
	return json.Marshal(out)
}

// isOrgAdmin reports whether the Grafana request user has org Admin role.
func isOrgAdmin(ctx context.Context) bool {
	u := backend.UserFromContext(ctx)
	if u == nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(u.Role), "Admin")
}

// isEditorOrAbove reports whether the Grafana request user may invoke engine
// tool routes (/query, /remediate). Org Editor and Admin qualify; Viewer,
// empty, unknown, and nil user fail closed.
func isEditorOrAbove(ctx context.Context) bool {
	u := backend.UserFromContext(ctx)
	if u == nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(u.Role)) {
	case "editor", "admin":
		return true
	default:
		return false
	}
}

func asMap(v any) map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return m
}

func trimmedStringAt(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	s, ok := m[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}

// extractSummary ports the frontend envelope walk: result.summary|analysis|message,
// then data.summary, then top-level summary.
func extractSummary(payload any) string {
	root := asMap(payload)
	if root == nil {
		return ""
	}
	data := asMap(root["data"])
	if data == nil {
		data = root
	}
	result := asMap(data["result"])
	if result == nil {
		result = asMap(root["result"])
	}
	if result != nil {
		for _, key := range []string{"summary", "analysis", "message"} {
			if s := trimmedStringAt(result, key); s != "" {
				return s
			}
		}
	}
	if s := trimmedStringAt(data, "summary"); s != "" {
		return s
	}
	return trimmedStringAt(root, "summary")
}

// extractErrorMessage ports the frontend error walk: error.message (+ optional code), else message.
func extractErrorMessage(payload any, fallback string) string {
	root := asMap(payload)
	if root == nil {
		return fallback
	}
	if errObj := asMap(root["error"]); errObj != nil {
		if msg := trimmedStringAt(errObj, "message"); msg != "" {
			if code := trimmedStringAt(errObj, "code"); code != "" {
				return code + ": " + msg
			}
			return msg
		}
	}
	if msg := trimmedStringAt(root, "message"); msg != "" {
		return msg
	}
	return fallback
}

// proxyDotAI forwards the request body to a dot-ai tools REST path and returns a
// stable {ok,status,summary,error} envelope (never the raw upstream body).
// When jsonData.debugLog is true, each completed call appends one JSON line to the ask log.
func (a *App) proxyDotAI(w http.ResponseWriter, req *http.Request, toolPath string) {
	tool := toolNameFromPath(toolPath)
	var reqBody []byte
	finish := func(httpStatus, status int, summary, errMsg string) {
		if errMsg != "" {
			log.DefaultLogger.Error("dot-ai tool call failed", "tool", tool, "status", status, "error", errMsg)
		}
		if a.debugLog {
			appendAskLog(req.Context(), tool, reqBody, status, summary, errMsg)
		}
		writeToolProxy(w, httpStatus, status, summary, errMsg)
	}

	if a.apiURL == "" || a.apiKey == "" {
		finish(http.StatusBadRequest, http.StatusBadRequest, "", "plugin not configured: set apiUrl and auth token")
		return
	}

	base, err := validateAPIURL(a.apiURL)
	if err != nil {
		finish(http.StatusBadRequest, http.StatusBadRequest, "", err.Error())
		return
	}

	const maxBody = 1 << 20 // 1 MiB
	var body []byte
	if req.Body != nil {
		// req.Body is nil (not an empty reader) when the resource call body was
		// empty — httpadapter only wraps req.Body when len(body) > 0. Guard here
		// instead of assuming a real Reader is always present.
		body, err = io.ReadAll(io.LimitReader(req.Body, maxBody+1))
		if err != nil {
			finish(http.StatusBadRequest, http.StatusBadRequest, "", "failed to read request body")
			return
		}
	}
	if len(body) > maxBody {
		finish(http.StatusRequestEntityTooLarge, http.StatusRequestEntityTooLarge, "", "request body too large")
		return
	}
	if len(body) == 0 {
		body = []byte("{}")
	}
	reqBody = body // original body (incl. hop meta) for ask-log

	// Drop hop meta before upstream; remediate stays analysis-only allowlist.
	sanitized, err := stripAskMetaForUpstream(body, toolPath)
	if err != nil {
		finish(http.StatusBadRequest, http.StatusBadRequest, "", err.Error())
		return
	}
	body = sanitized

	upstreamURL := base + toolPath
	httpReq, err := http.NewRequestWithContext(req.Context(), http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		finish(http.StatusBadRequest, http.StatusBadRequest, "", fmt.Sprintf("build upstream request: %v", err))
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+a.apiKey)
	httpReq.Header.Set("Accept", "application/json")

	client := a.toolHTTPClient
	if client == nil {
		client = a.httpClient
	}
	if client == nil {
		finish(http.StatusInternalServerError, http.StatusInternalServerError, "", "HTTP client not configured")
		return
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		log.DefaultLogger.Error("dot-ai tool proxy transport error", "tool", tool, "error", err)
		finish(http.StatusBadGateway, http.StatusBadGateway, "", classifyTransportError("dot-ai unreachable (502)", err))
		return
	}
	defer func() { _ = resp.Body.Close() }()

	const maxUpstreamBody = 8 << 20 // 8 MiB
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody+1))
	if err != nil {
		finish(http.StatusBadGateway, http.StatusBadGateway, "", "failed reading upstream body")
		return
	}
	if len(raw) > maxUpstreamBody {
		finish(http.StatusBadGateway, http.StatusBadGateway, "", "upstream response too large")
		return
	}

	var payload any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			// Non-JSON upstream: still envelope; do not reflect raw body.
			payload = nil
		}
	}

	ok := resp.StatusCode >= 200 && resp.StatusCode < 300
	summary := ""
	errMsg := ""
	if ok {
		summary = extractSummary(payload)
	} else {
		errMsg = extractErrorMessage(payload, fmt.Sprintf("dot-ai returned HTTP %d", resp.StatusCode))
	}

	// Body always carries the stable envelope. Never pass upstream 401/403 through as
	// Grafana resource status (session-looking auth failure); map to 502 instead.
	httpStatus := resp.StatusCode
	outStatus := resp.StatusCode
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		httpStatus = http.StatusBadGateway
		outStatus = http.StatusBadGateway
	}
	finish(httpStatus, outStatus, summary, errMsg)
}

// registerRoutes takes a *http.ServeMux and registers HTTP handlers.
func (a *App) registerRoutes(mux *http.ServeMux) {
	// /health is the sole liveness/connectivity probe (no separate /ping scaffold).
	mux.HandleFunc("/health", a.handleHealth)
	mux.HandleFunc("/test-connection", a.handleTestConnection)
	mux.HandleFunc("/query", a.handleQuery)
	mux.HandleFunc("/remediate", a.handleRemediate)
}
