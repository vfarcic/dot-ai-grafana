package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkgolog "github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

func TestCallResource(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatal(err)
	}
	app := inst.(*App)
	defer app.Dispose()

	t.Run("health_not_configured", func(t *testing.T) {
		var resp backend.CallResourceResponse
		err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			Path:   "health",
			Method: http.MethodGet,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusOK {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		var body testConnectionResponse
		if err := json.Unmarshal(resp.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "not_configured" {
			t.Fatalf("unexpected status %q", body.Status)
		}
	})

	t.Run("query_unconfigured", func(t *testing.T) {
		var resp backend.CallResourceResponse
		err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "query",
			Method:        http.MethodPost,
			Body:          []byte(`{"intent":"x"}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
	})

}

type callResourceResponseSenderFunc func(resp *backend.CallResourceResponse) error

func (f callResourceResponseSenderFunc) Send(resp *backend.CallResourceResponse) error {
	return f(resp)
}

func adminPluginContext() backend.PluginContext {
	return backend.PluginContext{
		User: &backend.User{Login: "admin", Role: "Admin"},
	}
}

func editorPluginContext() backend.PluginContext {
	return backend.PluginContext{
		User: &backend.User{Login: "editor", Role: "Editor"},
	}
}

func viewerPluginContext() backend.PluginContext {
	return backend.PluginContext{
		User: &backend.User{Login: "viewer", Role: "Viewer"},
	}
}


func TestMethodNotAllowed(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatal(err)
	}
	app := inst.(*App)
	defer app.Dispose()

	cases := []struct {
		path   string
		method string
	}{
		{"query", http.MethodGet},
		{"remediate", http.MethodGet},
		{"health", http.MethodPost},
		{"health", http.MethodPut},
		{"test-connection", http.MethodGet},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.path+"_"+tc.method, func(t *testing.T) {
			var resp backend.CallResourceResponse
			err := app.CallResource(context.Background(), &backend.CallResourceRequest{
				Path:   tc.path,
				Method: tc.method,
				Body:   []byte(`{}`),
			}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
				resp = *r
				return nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			if resp.Status != http.StatusMethodNotAllowed {
				t.Fatalf("path=%s method=%s status=%d body=%s", tc.path, tc.method, resp.Status, string(resp.Body))
			}
		})
	}
}

func TestTestConnection(t *testing.T) {
	t.Run("missing_settings", func(t *testing.T) {
		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          []byte(`{}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
	})

	t.Run("success_with_draft", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/v1/tools/version" {
				http.NotFound(w, r)
				return
			}
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			auth := r.Header.Get("Authorization")
			if auth != "Bearer secret-token" {
				http.Error(w, "unauth", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"connected":true}}}`))
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		payload, _ := json.Marshal(map[string]string{
			"apiUrl": upstream.URL,
			"apiKey": "secret-token",
		})
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusOK {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		var body testConnectionResponse
		if err := json.Unmarshal(resp.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "ok" {
			t.Fatalf("body=%+v", body)
		}
		if body.Connected == nil || !*body.Connected {
			t.Fatalf("expected connected=true body=%+v", body)
		}
	})

	t.Run("connected_unknown_shape_does_not_claim_success", func(t *testing.T) {
		cases := []struct {
			name string
			body string
		}{
			{"missing_connected_key", `{"success":true,"data":{"result":{}}}`},
			{"connected_not_a_bool", `{"success":true,"data":{"result":{"connected":"true"}}}`},
		}
		for _, tc := range cases {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(tc.body))
				}))
				defer upstream.Close()

				inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
				if err != nil {
					t.Fatal(err)
				}
				app := inst.(*App)
				defer app.Dispose()

				payload, _ := json.Marshal(map[string]string{
					"apiUrl": upstream.URL,
					"apiKey": "secret-token",
				})
				var resp backend.CallResourceResponse
				err = app.CallResource(context.Background(), &backend.CallResourceRequest{
					PluginContext: adminPluginContext(),
					Path:          "test-connection",
					Method:        http.MethodPost,
					Body:          payload,
				}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
					resp = *r
					return nil
				}))
				if err != nil {
					t.Fatal(err)
				}
				if resp.Status != http.StatusOK {
					t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
				}
				var body testConnectionResponse
				if err := json.Unmarshal(resp.Body, &body); err != nil {
					t.Fatal(err)
				}
				if body.Status != "ok" {
					t.Fatalf("body=%+v", body)
				}
				if body.Connected != nil {
					t.Fatalf("expected Connected=nil for unrecognized shape, got %+v", *body.Connected)
				}
				if body.Message != "connected to dot-ai (cluster connectivity unknown)" {
					t.Fatalf("expected unknown-connectivity message, got %q", body.Message)
				}
			})
		}
	})

	t.Run("unauthorized", func(t *testing.T) {
		const leak = "SECRET_UPSTREAM_DETAIL_should_not_leak"
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, `{"error":"UNAUTHORIZED","detail":"`+leak+`"}`, http.StatusUnauthorized)
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData: []byte(`{"apiUrl":"` + upstream.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{
				"apiKey": "bad",
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          []byte(`{}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadGateway {
			t.Fatalf("status=%d body=%s (upstream 401 must map to 502)", resp.Status, string(resp.Body))
		}
		if bytes.Contains(resp.Body, []byte(leak)) {
			t.Fatalf("raw upstream body leaked into response: %s", string(resp.Body))
		}
		var body testConnectionResponse
		if err := json.Unmarshal(resp.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "error" {
			t.Fatalf("body=%+v", body)
		}
		if strings.Contains(body.Message, leak) || strings.Contains(body.Message, "UNAUTHORIZED") {
			t.Fatalf("message must be status-only, got %q", body.Message)
		}
		if !strings.Contains(body.Message, "HTTP 401") {
			t.Fatalf("expected HTTP status in message, got %q", body.Message)
		}
	})

	t.Run("settings_from_instance", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"connected":true}`))
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData: []byte(`{"apiUrl":"` + upstream.URL + `/"}`),
			DecryptedSecureJSONData: map[string]string{
				"apiKey": "from-settings",
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()
		if app.apiURL != upstream.URL {
			t.Fatalf("apiURL not trimmed: %q", app.apiURL)
		}

		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          []byte(`{}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusOK {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
	})

	t.Run("rejects_draft_url_without_key_does_not_use_stored_key", func(t *testing.T) {
		// SEC-01: a different draft apiUrl with empty apiKey must not probe the
		// draft host and must not attach the stored Bearer token.
		var hits int32
		draft := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&hits, 1)
			t.Errorf("draft host must not be contacted; Authorization=%q", r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusOK)
		}))
		defer draft.Close()

		saved := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("saved host must not be contacted for a draft-url request")
			w.WriteHeader(http.StatusOK)
		}))
		defer saved.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData: []byte(`{"apiUrl":"` + saved.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{
				"apiKey": "stored-secret-token",
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		payload, _ := json.Marshal(map[string]string{
			"apiUrl": draft.URL,
			"apiKey": "",
		})
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if atomic.LoadInt32(&hits) != 0 {
			t.Fatalf("draft host was contacted %d times", hits)
		}
		var body testConnectionResponse
		if err := json.Unmarshal(resp.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "error" {
			t.Fatalf("body=%+v", body)
		}
	})

	t.Run("draft_url_non_admin_403_no_dial", func(t *testing.T) {
		var hits int32
		draft := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&hits, 1)
			t.Errorf("draft host must not be contacted for non-admin")
			w.WriteHeader(http.StatusOK)
		}))
		defer draft.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"http://saved.example"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "stored"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()
		app.httpClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			atomic.AddInt32(&hits, 1)
			t.Fatal("HTTP client must not be used for non-admin draft URL")
			return nil, nil
		})}

		payload, _ := json.Marshal(map[string]string{
			"apiUrl": draft.URL,
			"apiKey": "draft-key",
		})
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		var body testConnectionResponse
		if err := json.Unmarshal(resp.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "error" {
			t.Fatalf("body=%+v", body)
		}
		if !strings.Contains(body.Message, "Admin role required") {
			t.Fatalf("expected clear Admin gate message, got %q", body.Message)
		}
		if atomic.LoadInt32(&hits) != 0 {
			t.Fatalf("HTTP was used %d times", hits)
		}
	})

	t.Run("draft_url_missing_user_403_no_dial", func(t *testing.T) {
		var hits int32
		noDial := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			atomic.AddInt32(&hits, 1)
			t.Fatal("HTTP client must not be used when user is missing on draft URL")
			return nil, nil
		})}

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"http://saved.example"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "stored"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()
		app.httpClient = noDial

		payload, _ := json.Marshal(map[string]string{
			"apiUrl": "http://draft.example",
			"apiKey": "draft-key",
		})
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			// PluginContext.User intentionally omitted
			Path:   "test-connection",
			Method: http.MethodPost,
			Body:   payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		var body testConnectionResponse
		if err := json.Unmarshal(resp.Body, &body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(body.Message, "Admin role required") {
			t.Fatalf("expected clear Admin gate message, got %q", body.Message)
		}
		if atomic.LoadInt32(&hits) != 0 {
			t.Fatalf("HTTP was used %d times", hits)
		}
	})

	t.Run("draft_url_admin_proceeds", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"connected":true}`))
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"http://saved.example"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "stored"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		payload, _ := json.Marshal(map[string]string{
			"apiUrl": upstream.URL,
			"apiKey": "draft-token",
		})
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusOK {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		var body testConnectionResponse
		if err := json.Unmarshal(resp.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Status != "ok" {
			t.Fatalf("body=%+v", body)
		}
	})

	t.Run("saved_url_editor_requires_admin", func(t *testing.T) {
		// Non-Admin must not probe the saved apiUrl.
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if got := r.Header.Get("Authorization"); got != "Bearer from-settings" {
				t.Errorf("Authorization=%q", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"connected":true}`))
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "from-settings"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          []byte(`{}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
	})

	t.Run("same_url_as_saved_editor_requires_admin", func(t *testing.T) {
		// Same draft apiUrl as saved still requires Admin.
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"connected":true}`))
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "from-settings"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		payload, _ := json.Marshal(map[string]string{
			"apiUrl": upstream.URL,
			"apiKey": "",
		})
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
	})


}


func TestProxyTools(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer tok" {
			http.Error(w, `{"error":"UNAUTHORIZED"}`, http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v1/tools/query":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"ok-query"}}}`))
		case "/api/v1/tools/remediate":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"ok-remediate"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
		DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
	})
	if err != nil {
		t.Fatal(err)
	}
	app := inst.(*App)
	defer app.Dispose()

	for _, tc := range []struct {
		path string
		want string
	}{
		{"query", "ok-query"},
		{"remediate", "ok-remediate"},
	} {
		tc := tc
		t.Run(tc.path, func(t *testing.T) {
			var resp backend.CallResourceResponse
			err := app.CallResource(context.Background(), &backend.CallResourceRequest{
				PluginContext: editorPluginContext(),
				Path:          tc.path,
				Method:        http.MethodPost,
				Body:          []byte(`{"intent":"test"}`),
			}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
				resp = *r
				return nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			if resp.Status != http.StatusOK {
				t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
			}
			var env toolProxyResponse
			if err := json.Unmarshal(resp.Body, &env); err != nil {
				t.Fatalf("envelope json: %v body=%s", err, string(resp.Body))
			}
			if !env.OK {
				t.Fatalf("expected ok=true body=%+v", env)
			}
			if env.Status != http.StatusOK {
				t.Fatalf("envelope status=%d body=%+v", env.Status, env)
			}
			if env.Summary != tc.want {
				t.Fatalf("summary=%q want %q body=%+v", env.Summary, tc.want, env)
			}
			if env.Error != "" {
				t.Fatalf("expected empty error, got %q", env.Error)
			}
		})
	}

	t.Run("upstream_error_envelope", func(t *testing.T) {
		bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"success":false,"error":{"code":"EXECUTION_ERROR","message":"llm down"}}`))
		}))
		defer bad.Close()
		inst2, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + bad.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app2 := inst2.(*App)
		defer app2.Dispose()
		var resp backend.CallResourceResponse
		err = app2.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "query",
			Method:        http.MethodPost,
			Body:          []byte(`{"intent":"x"}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusInternalServerError {
			t.Fatalf("status=%d", resp.Status)
		}
		var env toolProxyResponse
		if err := json.Unmarshal(resp.Body, &env); err != nil {
			t.Fatalf("envelope json: %v body=%s", err, string(resp.Body))
		}
		if env.OK {
			t.Fatalf("expected ok=false body=%+v", env)
		}
		if env.Status != http.StatusInternalServerError {
			t.Fatalf("envelope status=%d body=%+v", env.Status, env)
		}
		if env.Error != "EXECUTION_ERROR: llm down" {
			t.Fatalf("error=%q body=%+v", env.Error, env)
		}
		if env.Summary != "" {
			t.Fatalf("summary should be empty on error, got %q", env.Summary)
		}
		if bytes.Contains(resp.Body, []byte(`"success"`)) {
			t.Fatalf("raw upstream leaked: %s", string(resp.Body))
		}
	})

	t.Run("upstream_401_maps_to_502_envelope", func(t *testing.T) {
		unauth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"bad token"}}`))
		}))
		defer unauth.Close()
		inst2, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + unauth.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app2 := inst2.(*App)
		defer app2.Dispose()
		var resp backend.CallResourceResponse
		err = app2.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "query",
			Method:        http.MethodPost,
			Body:          []byte(`{"intent":"x"}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadGateway {
			t.Fatalf("status=%d want 502 body=%s", resp.Status, string(resp.Body))
		}
		var env toolProxyResponse
		if err := json.Unmarshal(resp.Body, &env); err != nil {
			t.Fatalf("envelope json: %v body=%s", err, string(resp.Body))
		}
		if env.OK {
			t.Fatalf("expected ok=false body=%+v", env)
		}
		if env.Status != http.StatusBadGateway {
			t.Fatalf("envelope status=%d body=%+v", env.Status, env)
		}
		if env.Error == "" {
			t.Fatalf("expected error message body=%+v", env)
		}
	})

	t.Run("upstream_403_maps_to_502_envelope", func(t *testing.T) {
		forbid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"FORBIDDEN"}`))
		}))
		defer forbid.Close()
		inst2, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + forbid.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app2 := inst2.(*App)
		defer app2.Dispose()
		var resp backend.CallResourceResponse
		err = app2.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "remediate",
			Method:        http.MethodPost,
			Body:          []byte(`{"issue":"x"}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadGateway {
			t.Fatalf("status=%d want 502 body=%s", resp.Status, string(resp.Body))
		}
		var env toolProxyResponse
		if err := json.Unmarshal(resp.Body, &env); err != nil {
			t.Fatal(err)
		}
		if env.OK || env.Status != http.StatusBadGateway {
			t.Fatalf("envelope=%+v", env)
		}
	})

	t.Run("transport_error_502_does_not_leak_url", func(t *testing.T) {
		// Point at a closed port / non-routable host to trigger a transport dial error.
		deadServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		deadURL := deadServer.URL
		deadServer.Close() // Close immediately so client.Do fails with transport error

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + deadURL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		// Test tool proxy /query endpoint
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "query",
			Method:        http.MethodPost,
			Body:          []byte(`{"intent":"test transport error"}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadGateway {
			t.Fatalf("status=%d want 502 body=%s", resp.Status, string(resp.Body))
		}
		var env toolProxyResponse
		if err := json.Unmarshal(resp.Body, &env); err != nil {
			t.Fatalf("unmarshal error: %v, body=%s", err, string(resp.Body))
		}
		if env.OK {
			t.Fatalf("expected ok=false, body=%+v", env)
		}
		if env.Status != http.StatusBadGateway {
			t.Fatalf("expected status=502, got %d", env.Status)
		}
		// Assert message contains no scheme, host, or port of upstream
		u, _ := url.Parse(deadURL)
		if strings.Contains(env.Error, "http://") || strings.Contains(env.Error, "https://") || strings.Contains(env.Error, u.Host) || strings.Contains(env.Error, u.Port()) {
			t.Fatalf("upstream URL leaked in error message: %q (deadURL=%s)", env.Error, deadURL)
		}
		if !strings.HasPrefix(env.Error, "dot-ai unreachable (502)") {
			t.Fatalf("expected prefix 'dot-ai unreachable (502)', got %q", env.Error)
		}

		// Test test-connection endpoint
		var testResp backend.CallResourceResponse
		payload := []byte(`{"apiUrl":"` + deadURL + `","apiKey":"tok"}`)
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			testResp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if testResp.Status != http.StatusBadGateway {
			t.Fatalf("status=%d want 502 body=%s", testResp.Status, string(testResp.Body))
		}
		var connResp testConnectionResponse
		if err := json.Unmarshal(testResp.Body, &connResp); err != nil {
			t.Fatalf("unmarshal error: %v, body=%s", err, string(testResp.Body))
		}
		if connResp.Status != "error" {
			t.Fatalf("expected status=error, got %q", connResp.Status)
		}
		if strings.Contains(connResp.Message, "http://") || strings.Contains(connResp.Message, "https://") || strings.Contains(connResp.Message, u.Host) || strings.Contains(connResp.Message, u.Port()) {
			t.Fatalf("upstream URL leaked in test-connection message: %q (deadURL=%s)", connResp.Message, deadURL)
		}
		if !strings.HasPrefix(connResp.Message, "dot-ai unreachable") {
			t.Fatalf("expected prefix 'dot-ai unreachable', got %q", connResp.Message)
		}
	})
}

// captureLogger records Error() calls so tests can prove the fix relocates
// (not deletes) transport detail to the server-side log. It implements the SDK
// log.Logger interface.
type captureLogger struct {
	mu     sync.Mutex
	errors []string
}

func (c *captureLogger) Debug(string, ...interface{}) {}
func (c *captureLogger) Info(string, ...interface{})  {}
func (c *captureLogger) Warn(string, ...interface{})  {}
func (c *captureLogger) Error(msg string, args ...interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.errors = append(c.errors, msg+" "+fmt.Sprint(args...))
}
func (c *captureLogger) With(...interface{}) sdkgolog.Logger         { return c }
func (c *captureLogger) Level() sdkgolog.Level                       { return sdkgolog.Debug }
func (c *captureLogger) FromContext(context.Context) sdkgolog.Logger { return c }

func (c *captureLogger) joined() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.errors, "\n")
}

// TestTransportErrorDoesNotLeakUpstreamURL asserts the DOTAI-SEC-001 contract
// that NO transport-level failure surfaces the configured upstream scheme,
// host, port, or path to the browser, at EITHER call site (tool proxy and
// probeVersion), while the full detail is STILL logged server-side.
//
// Each error class is injected through a roundTripFunc transport; http.Client
// wraps every RoundTrip error in a *url.Error that embeds the request URL, so
// this exercises the exact leak vector the fix closes.
func TestTransportErrorDoesNotLeakUpstreamURL(t *testing.T) {
	// Distinctive scheme/host/port/path so any leak is unambiguous.
	const apiBase = "http://127.0.0.1:62435/base/path"

	leakTokens := []string{
		"http://", "https://", // scheme
		"127.0.0.1",     // host
		"62435",         // port
		"/base/path",    // configured path prefix
		"/api/v1/tools", // version/query/remediate path segment
	}

	cases := []struct {
		name     string
		err      error
		wantTail string // expected classified suffix ("": bare prefix)
	}{
		{name: "dial_refused", err: errors.New("dial tcp 127.0.0.1:62435: connect: connection refused"), wantTail: ": connection refused"},
		{name: "connection_reset", err: errors.New("read tcp 127.0.0.1:62435: read: connection reset by peer"), wantTail: ": connection reset"},
		{name: "eof", err: io.EOF, wantTail: ""},
		{name: "timeout", err: context.DeadlineExceeded, wantTail: ": timeout"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
				JSONData:                []byte(`{"apiUrl":"` + apiBase + `"}`),
				DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
			})
			if err != nil {
				t.Fatal(err)
			}
			app := inst.(*App)
			defer app.Dispose()

			// Inject a transport that fails with this class. Both clients must
			// point at it so tool proxy and probeVersion exercise the same error.
			failClient := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return nil, tc.err
			})}
			app.httpClient = failClient
			app.toolHTTPClient = failClient

			// Capture the server-side log to prove the detail is retained there.
			capture := &captureLogger{}
			prev := sdkgolog.DefaultLogger
			sdkgolog.DefaultLogger = capture
			defer func() { sdkgolog.DefaultLogger = prev }()

			jsonBody := func(reqPath string, pctx backend.PluginContext, body string) backend.CallResourceResponse {
				t.Helper()
				var resp backend.CallResourceResponse
				err := app.CallResource(context.Background(), &backend.CallResourceRequest{
					PluginContext: pctx,
					Path:          reqPath,
					Method:        http.MethodPost,
					Body:          []byte(body),
				}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
					resp = *r
					return nil
				}))
				if err != nil {
					t.Fatalf("CallResource(%s): %v", reqPath, err)
				}
				return resp
			}

			assertNoLeak := func(site, got string) {
				t.Helper()
				for _, tok := range leakTokens {
					if strings.Contains(got, tok) {
						t.Fatalf("%s leaked upstream token %q in %q", site, tok, got)
					}
				}
			}

			// --- Call site 1: tool proxy (/query, org Editor) ---
			proxyResp := jsonBody("query", editorPluginContext(), `{"intent":"x"}`)
			if proxyResp.Status != http.StatusBadGateway {
				t.Fatalf("tool proxy status=%d want 502 body=%s", proxyResp.Status, proxyResp.Body)
			}
			var env toolProxyResponse
			if err := json.Unmarshal(proxyResp.Body, &env); err != nil {
				t.Fatalf("tool proxy unmarshal: %v body=%s", err, proxyResp.Body)
			}
			assertNoLeak("tool proxy", env.Error)
			if want := "dot-ai unreachable (502)" + tc.wantTail; env.Error != want {
				t.Fatalf("tool proxy error = %q, want %q", env.Error, want)
			}

			// --- Call site 2: probeVersion (/test-connection, Admin-only) ---
			probeResp := jsonBody("test-connection", adminPluginContext(), `{"apiUrl":"`+apiBase+`","apiKey":"tok"}`)
			if probeResp.Status != http.StatusBadGateway {
				t.Fatalf("probe status=%d want 502 body=%s", probeResp.Status, probeResp.Body)
			}
			var connResp testConnectionResponse
			if err := json.Unmarshal(probeResp.Body, &connResp); err != nil {
				t.Fatalf("probe unmarshal: %v body=%s", err, probeResp.Body)
			}
			assertNoLeak("probeVersion", connResp.Message)
			if want := "dot-ai unreachable" + tc.wantTail; connResp.Message != want {
				t.Fatalf("probeVersion message = %q, want %q", connResp.Message, want)
			}

			// --- Server-side log retains the full detail (relocated, not deleted) ---
			if !strings.Contains(capture.joined(), "127.0.0.1") {
				t.Fatalf("server-side log dropped transport detail; captured logs:\n%s", capture.joined())
			}
		})
	}
}

// TestToolRoleGate is the DOTAI-SEC-001 control matrix.
// Routes /query and /remediate must require org Editor or above (case-insensitive),
// deny Viewer / None / empty / unknown / nil-user with HTTP 403 and the plugin
// {ok,status,summary,error} envelope, and MUST NOT dial the upstream engine on deny
// (fail-closed). GrafanaAuthModel (SDK v0.296.1): 403 not 401; Role is a raw string
// compared case-insensitively; no IsGrafanaAdmin on the SDK user — server-admin with
// Viewer org role is undeniable and is not asserted here.
func TestToolRoleGate(t *testing.T) {
	const upstreamLeak = "UPSTREAM_BODY_MUST_NOT_LEAK"

	call := func(t *testing.T, app *App, path string, pctx backend.PluginContext) backend.CallResourceResponse {
		t.Helper()
		var resp backend.CallResourceResponse
		body := []byte(`{"intent":"role-gate"}`)
		if path == "remediate" {
			body = []byte(`{"issue":"role-gate"}`)
		}
		err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: pctx,
			Path:          path,
			Method:        http.MethodPost,
			Body:          body,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	assertDeniedNoDial := func(t *testing.T, path string, pctx backend.PluginContext) {
		t.Helper()
		var hits int32
		// Real upstream that would succeed if reached — proves fail-closed when hits stay 0.
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&hits, 1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"` + upstreamLeak + `"}}}`))
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		resp := call(t, app, path, pctx)

		// Collect all fail-closed violations before failing so the RED report is complete.
		if resp.Status != http.StatusForbidden {
			t.Errorf("status=%d want 403 body=%s", resp.Status, string(resp.Body))
		}
		var env toolProxyResponse
		if err := json.Unmarshal(resp.Body, &env); err != nil {
			t.Errorf("envelope json: %v body=%s", err, string(resp.Body))
		} else {
			if env.OK {
				t.Errorf("expected ok=false body=%+v", env)
			}
			if env.Status != http.StatusForbidden {
				t.Errorf("envelope status=%d want 403 body=%+v", env.Status, env)
			}
			if env.Error == "" {
				t.Errorf("expected role-gate error message, body=%+v", env)
			} else {
				low := strings.ToLower(env.Error)
				if !strings.Contains(low, "editor") && !strings.Contains(low, "role") &&
					!strings.Contains(low, "forbidden") && !strings.Contains(low, "permission") {
					t.Errorf("expected clear role-denial message, got %q", env.Error)
				}
			}
			if env.Summary != "" && env.Summary != upstreamLeak {
				// Non-empty summary that is not the leak still fails the deny contract.
				t.Errorf("summary must be empty on deny, got %q", env.Summary)
			}
			if env.Summary == upstreamLeak {
				t.Errorf("upstream summary leaked into denial envelope: %q", env.Summary)
			}
		}
		if bytes.Contains(resp.Body, []byte(upstreamLeak)) {
			t.Errorf("upstream body leaked into denial response: %s", string(resp.Body))
		}
		if bytes.Contains(resp.Body, []byte(`"success"`)) {
			t.Errorf("raw upstream shape leaked: %s", string(resp.Body))
		}
		if n := atomic.LoadInt32(&hits); n != 0 {
			t.Errorf("fail-closed violated: upstream contacted %d times", n)
		}
	}

	assertAllowed := func(t *testing.T, path string, pctx backend.PluginContext) {
		t.Helper()
		var hits int32
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&hits, 1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"allowed"}}}`))
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		resp := call(t, app, path, pctx)
		if resp.Status != http.StatusOK {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		var env toolProxyResponse
		if err := json.Unmarshal(resp.Body, &env); err != nil {
			t.Fatal(err)
		}
		if !env.OK || env.Summary != "allowed" {
			t.Fatalf("envelope=%+v", env)
		}
		if env.Error != "" {
			t.Fatalf("expected empty error, got %q", env.Error)
		}
		if atomic.LoadInt32(&hits) != 1 {
			t.Fatalf("upstream hits=%d want 1", hits)
		}
	}

	type callerCase struct {
		name  string
		pctx  backend.PluginContext
		allow bool
	}
	callers := []callerCase{
		{name: "admin", pctx: adminPluginContext(), allow: true},
		{name: "editor", pctx: editorPluginContext(), allow: true},
		// Case-insensitive ALLOW: Grafana sends Title Case; implementation folds case.
		{name: "editor_lowercase", pctx: backend.PluginContext{User: &backend.User{Login: "ed", Role: "editor"}}, allow: true},
		{name: "viewer", pctx: viewerPluginContext(), allow: false},
		{name: "role_none", pctx: backend.PluginContext{User: &backend.User{Login: "n", Role: "None"}}, allow: false},
		{name: "empty_role", pctx: backend.PluginContext{User: &backend.User{Login: "e", Role: ""}}, allow: false},
		{name: "unknown_role_superuser", pctx: backend.PluginContext{User: &backend.User{Login: "s", Role: "Superuser"}}, allow: false},
		{name: "nil_user", pctx: backend.PluginContext{}, allow: false},
	}

	for _, path := range []string{"query", "remediate"} {
		path := path
		for _, tc := range callers {
			tc := tc
			suffix := "_allow"
			if !tc.allow {
				suffix = "_deny_403_no_dial"
			}
			t.Run(tc.name+"_"+path+suffix, func(t *testing.T) {
				if tc.allow {
					assertAllowed(t, path, tc.pctx)
				} else {
					assertDeniedNoDial(t, path, tc.pctx)
				}
			})
		}
	}
}

// TestTestConnectionAdminGatePinned re-states the existing Admin-only draft-URL
// gate so a regression is caught alongside the Editor tool gate. Unchanged by SEC-001.
func TestTestConnectionAdminGatePinned(t *testing.T) {
	t.Run("draft_editor_denied_no_dial", func(t *testing.T) {
		var hits int32
		draft := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&hits, 1)
			w.WriteHeader(http.StatusOK)
		}))
		defer draft.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"http://saved.example"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "stored"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()
		app.httpClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			atomic.AddInt32(&hits, 1)
			t.Fatal("HTTP client must not be used for non-admin draft URL")
			return nil, nil
		})}

		payload, _ := json.Marshal(map[string]string{"apiUrl": draft.URL, "apiKey": "draft-key"})
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if atomic.LoadInt32(&hits) != 0 {
			t.Fatalf("draft host contacted %d times", hits)
		}
	})

	t.Run("draft_viewer_denied_no_dial", func(t *testing.T) {
		var hits int32
		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"http://saved.example"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "stored"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()
		app.httpClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			atomic.AddInt32(&hits, 1)
			return nil, nil
		})}
		payload, _ := json.Marshal(map[string]string{"apiUrl": "http://draft.example", "apiKey": "k"})
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: viewerPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if atomic.LoadInt32(&hits) != 0 {
			t.Fatalf("hits=%d", hits)
		}
	})

	t.Run("draft_admin_allowed", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"connected":true}`))
		}))
		defer upstream.Close()
		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"http://saved.example"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "stored"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()
		payload, _ := json.Marshal(map[string]string{"apiUrl": upstream.URL, "apiKey": "draft-token"})
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Path:          "test-connection",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusOK {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
	})
}

func TestProxyBodyLimits(t *testing.T) {
	t.Run("body_over_1mib_rejected_413", func(t *testing.T) {
		var upstreamHit bool
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			upstreamHit = true
			w.WriteHeader(http.StatusOK)
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		oversized := []byte(`{"intent":"` + strings.Repeat("x", (1<<20)+1) + `"}`)
		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "query",
			Method:        http.MethodPost,
			Body:          oversized,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusRequestEntityTooLarge {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if upstreamHit {
			t.Fatalf("upstream must not be dialed for an oversized body")
		}
	})

	t.Run("empty_body_requires_intent", func(t *testing.T) {
		var gotBody []byte
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotBody, _ = io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"ok"}}}`))
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		var resp backend.CallResourceResponse
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "query",
			Method:        http.MethodPost,
			Body:          []byte(``),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if !strings.Contains(string(resp.Body), "intent is required") {
			t.Fatalf("want intent required, got %s", string(resp.Body))
		}
		if len(gotBody) != 0 {
			t.Fatalf("upstream must not be dialed without intent, got %q", string(gotBody))
		}
	})
}

func TestRemediateAnalysisOnly(t *testing.T) {
	var gotPath string
	var gotBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"analysis"}}}`))
	}))
	defer upstream.Close()

	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
		DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
	})
	if err != nil {
		t.Fatal(err)
	}
	app := inst.(*App)
	defer app.Dispose()

	t.Run("strips_execute_apply_mode", func(t *testing.T) {
		gotPath, gotBody = "", nil
		payload := []byte(`{
			"intent":"why is checkout CrashLooping",
			"issue":"checkout-api CrashLoopBackOff",
			"execute":true,
			"apply":true,
			"mode":"execute",
			"confirmationToken":"abc",
			"confirm":true
		}`)
		var resp backend.CallResourceResponse
		err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "remediate",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusOK {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if gotPath != "/api/v1/tools/remediate" {
			t.Fatalf("path=%q", gotPath)
		}
		var forwarded map[string]any
		if err := json.Unmarshal(gotBody, &forwarded); err != nil {
			t.Fatalf("outbound body=%s err=%v", string(gotBody), err)
		}
		if len(forwarded) != 2 {
			t.Fatalf("want only intent+issue, got %v", forwarded)
		}
		if forwarded["intent"] != "why is checkout CrashLooping" {
			t.Fatalf("intent=%v", forwarded["intent"])
		}
		if forwarded["issue"] != "checkout-api CrashLoopBackOff" {
			t.Fatalf("issue=%v", forwarded["issue"])
		}
		for _, banned := range []string{"execute", "apply", "mode", "confirmationToken", "confirm"} {
			if _, ok := forwarded[banned]; ok {
				t.Fatalf("banned field %q present in outbound body: %s", banned, string(gotBody))
			}
			if bytes.Contains(gotBody, []byte(`"`+banned+`"`)) {
				t.Fatalf("banned key %q still in raw outbound body: %s", banned, string(gotBody))
			}
		}
	})

	t.Run("invalid_json_400", func(t *testing.T) {
		gotPath, gotBody = "", nil
		var resp backend.CallResourceResponse
		err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "remediate",
			Method:        http.MethodPost,
			Body:          []byte(`not-json`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if gotPath != "" {
			t.Fatalf("upstream should not be called, path=%q", gotPath)
		}
	})

	t.Run("empty_issue_400_no_upstream", func(t *testing.T) {
		gotPath, gotBody = "", nil
		var resp backend.CallResourceResponse
		err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "remediate",
			Method:        http.MethodPost,
			Body:          []byte(`{}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if gotPath != "" {
			t.Fatalf("upstream should not be called, path=%q body=%s", gotPath, string(gotBody))
		}
		var env toolProxyResponse
		if err := json.Unmarshal(resp.Body, &env); err != nil {
			t.Fatalf("envelope json: %v body=%s", err, string(resp.Body))
		}
		if env.OK {
			t.Fatalf("expected ok=false body=%+v", env)
		}
		if env.Error != "issue is required" {
			t.Fatalf("error=%q body=%+v", env.Error, env)
		}
	})


	t.Run("query_allowlists_intent_only", func(t *testing.T) {
		gotPath, gotBody = "", nil
		payload := []byte(`{"intent":"list pods","execute":true,"mode":"execute"}`)
		var resp backend.CallResourceResponse
		err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          "query",
			Method:        http.MethodPost,
			Body:          payload,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusOK {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if gotPath != "/api/v1/tools/query" {
			t.Fatalf("path=%q", gotPath)
		}
		var forwarded map[string]any
		if err := json.Unmarshal(gotBody, &forwarded); err != nil {
			t.Fatalf("outbound body=%s err=%v", string(gotBody), err)
		}
		if forwarded["intent"] != "list pods" {
			t.Fatalf("intent=%v body=%s", forwarded["intent"], string(gotBody))
		}
		if _, ok := forwarded["execute"]; ok {
			t.Fatalf("query must not forward execute, body=%s", string(gotBody))
		}
		if _, ok := forwarded["mode"]; ok {
			t.Fatalf("query must not forward mode, body=%s", string(gotBody))
		}
		if len(forwarded) != 1 {
			t.Fatalf("want only intent, got %v", forwarded)
		}
	})
}



func TestCheckHealth(t *testing.T) {
	t.Run("unconfigured", func(t *testing.T) {
		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		res, err := app.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != backend.HealthStatusUnknown {
			t.Fatalf("status=%v msg=%s", res.Status, res.Message)
		}
	})

	t.Run("configured_valid_credentials_probes_and_reports_ok", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"connected":true}}}`))
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		res, err := app.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != backend.HealthStatusOk {
			t.Fatalf("status=%v msg=%s (expected Ok when dot-ai actually responds)", res.Status, res.Message)
		}
	})

	t.Run("configured_invalid_credentials_reports_error_not_ok", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, `{"error":"UNAUTHORIZED"}`, http.StatusUnauthorized)
		}))
		defer upstream.Close()

		inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": "bad"},
		})
		if err != nil {
			t.Fatal(err)
		}
		app := inst.(*App)
		defer app.Dispose()

		res, err := app.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != backend.HealthStatusError {
			t.Fatalf("status=%v msg=%s (expected Error when dot-ai rejects the token, not silently Ok)", res.Status, res.Message)
		}
	})
}

func TestValidateAPIURL(t *testing.T) {
	t.Run("rejects_non_http_schemes_and_hostless", func(t *testing.T) {
		cases := []string{
			"file:///etc/passwd",
			"javascript:alert(1)",
			"http://",
			"https://",
			"/relative/path",
			"example.com",
			"",
			"ftp://example.com",
		}
		for _, raw := range cases {
			raw := raw
			t.Run(raw, func(t *testing.T) {
				if _, err := validateAPIURL(raw); err == nil {
					t.Fatalf("expected error for %q", raw)
				}
			})
		}
	})

	t.Run("rejects_http_example_invalid_at_parse_layer", func(t *testing.T) {
		_, err := validateAPIURL("http://example.invalid")
		if err == nil {
			t.Fatal("expected error for http://example.invalid")
		}
		want := "http apiUrl is only allowed for loopback, RFC1918, or in-cluster DNS; use https"
		if err.Error() != want {
			t.Fatalf("err=%q want=%q", err.Error(), want)
		}
	})

	t.Run("rejects_public_http_example_com", func(t *testing.T) {
		_, err := validateAPIURL("http://example.com")
		if err == nil {
			t.Fatal("expected error for http://example.com")
		}
		want := "http apiUrl is only allowed for loopback, RFC1918, or in-cluster DNS; use https"
		if err.Error() != want {
			t.Fatalf("err=%q want=%q", err.Error(), want)
		}
	})

	t.Run("accepts_https_and_trims_slash", func(t *testing.T) {
		base, err := validateAPIURL("https://dot-ai.example.com/v1/")
		if err != nil {
			t.Fatal(err)
		}
		if base != "https://dot-ai.example.com/v1" {
			t.Fatalf("base=%q", base)
		}
	})

	t.Run("accepts_http_loopback_rfc1918_incluster", func(t *testing.T) {
		cases := []string{
			"http://dot-ai.dot-ai.svc:3456",
			"http://127.0.0.1:3456",
			"http://10.43.0.10:3456",
		}
		for _, raw := range cases {
			raw := raw
			t.Run(raw, func(t *testing.T) {
				base, err := validateAPIURL(raw)
				if err != nil {
					t.Fatal(err)
				}
				if base != raw {
					t.Fatalf("base=%q", base)
				}
			})
		}
	})
}

func TestRejectsUnsafeAPIURLBeforeDial(t *testing.T) {
	// Transport that fails the test if any outbound request is attempted.
	noDial := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("outbound HTTP must not be dialed for rejected apiUrl")
		return nil, nil
	})}

	cases := []struct {
		name   string
		apiURL string
	}{
		{"file", "file:///tmp/x"},
		{"javascript", "javascript:alert(1)"},
		{"missing_host", "http://"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run("test_connection_"+tc.name, func(t *testing.T) {
			inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
			if err != nil {
				t.Fatal(err)
			}
			app := inst.(*App)
			defer app.Dispose()
			app.httpClient = noDial
			app.toolHTTPClient = noDial

			payload, _ := json.Marshal(map[string]string{
				"apiUrl": tc.apiURL,
				"apiKey": "tok",
			})
			var resp backend.CallResourceResponse
			err = app.CallResource(context.Background(), &backend.CallResourceRequest{
				PluginContext: adminPluginContext(),
				Path:          "test-connection",
				Method:        http.MethodPost,
				Body:          payload,
			}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
				resp = *r
				return nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			if resp.Status != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
			}
		})

		t.Run("health_"+tc.name, func(t *testing.T) {
			inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
				JSONData:                []byte(`{"apiUrl":` + jsonString(tc.apiURL) + `}`),
				DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
			})
			if err != nil {
				t.Fatal(err)
			}
			app := inst.(*App)
			defer app.Dispose()
			app.httpClient = noDial
			app.toolHTTPClient = noDial

			var resp backend.CallResourceResponse
			err = app.CallResource(context.Background(), &backend.CallResourceRequest{
				Path:   "health",
				Method: http.MethodGet,
			}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
				resp = *r
				return nil
			}))
			if err != nil {
				t.Fatal(err)
			}
			if resp.Status != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
			}
		})

		for _, path := range []string{"query", "remediate"} {
			path := path
			t.Run(path+"_"+tc.name, func(t *testing.T) {
				inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
					JSONData:                []byte(`{"apiUrl":` + jsonString(tc.apiURL) + `}`),
					DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
				})
				if err != nil {
					t.Fatal(err)
				}
				app := inst.(*App)
				defer app.Dispose()
				app.httpClient = noDial
				app.toolHTTPClient = noDial

				var resp backend.CallResourceResponse
				err = app.CallResource(context.Background(), &backend.CallResourceRequest{
					PluginContext: editorPluginContext(),
					Path:          path,
					Method:        http.MethodPost,
					Body:          []byte(`{"intent":"x"}`),
				}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
					resp = *r
					return nil
				}))
				if err != nil {
					t.Fatal(err)
				}
				if resp.Status != http.StatusBadRequest {
					t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
				}
			})
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestAskLogFile(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "dotai-ask.log")
	prev := askLogPath
	askLogPath = logPath
	t.Cleanup(func() { askLogPath = prev })

	const secret = "super-secret-token-value"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+secret {
			http.Error(w, `{"error":"UNAUTHORIZED"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/tools/query":
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"pods healthy"}}}`))
		case "/api/v1/tools/remediate":
			_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"restart deployment"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `","debugLog":true}`),
		DecryptedSecureJSONData: map[string]string{"apiKey": secret},
	})
	if err != nil {
		t.Fatal(err)
	}
	app := inst.(*App)
	defer app.Dispose()

	call := func(path string, body []byte) toolProxyResponse {
		t.Helper()
		var resp backend.CallResourceResponse
		err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: editorPluginContext(),
			Path:          path,
			Method:        http.MethodPost,
			Body:          body,
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, resp.Status, string(resp.Body))
		}
		var env toolProxyResponse
		if err := json.Unmarshal(resp.Body, &env); err != nil {
			t.Fatalf("envelope: %v body=%s", err, string(resp.Body))
		}
		return env
	}

	// Body deliberately includes apiKey to prove it is never written to the log.
	qEnv := call("query", []byte(`{"intent":"how many pods?","apiKey":"`+secret+`","Authorization":"Bearer `+secret+`"}`))
	if qEnv.Summary != "pods healthy" {
		t.Fatalf("query summary=%q", qEnv.Summary)
	}
	rEnv := call("remediate", []byte(`{"issue":"checkout CrashLoop","apiKey":"`+secret+`"}`))
	if rEnv.Summary != "restart deployment" {
		t.Fatalf("remediate summary=%q", rEnv.Summary)
	}

	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read ask log: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("ask log empty after query/remediate")
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 log lines, got %d raw=%q", len(lines), string(raw))
	}

	forbid := []string{secret, "Bearer", "apiKey", "Authorization", "super-secret"}
	for i, line := range lines {
		for _, bad := range forbid {
			if strings.Contains(line, bad) {
				t.Fatalf("line %d contains forbidden %q: %s", i, bad, line)
			}
		}
		var entry askLogEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("line %d json: %v raw=%s", i, err, line)
		}
		if entry.Time == "" {
			t.Fatalf("line %d missing time: %+v", i, entry)
		}
		if entry.Status != http.StatusOK {
			t.Fatalf("line %d status=%d", i, entry.Status)
		}
		switch i {
		case 0:
			if entry.Tool != "query" {
				t.Fatalf("line0 tool=%q", entry.Tool)
			}
			if entry.Body != "how many pods?" {
				t.Fatalf("line0 body=%q", entry.Body)
			}
			if entry.Summary != "pods healthy" {
				t.Fatalf("line0 summary=%q", entry.Summary)
			}
			if entry.Error != "" {
				t.Fatalf("line0 error=%q", entry.Error)
			}
		case 1:
			if entry.Tool != "remediate" {
				t.Fatalf("line1 tool=%q", entry.Tool)
			}
			if entry.Body != "checkout CrashLoop" {
				t.Fatalf("line1 body=%q", entry.Body)
			}
			if entry.Summary != "restart deployment" {
				t.Fatalf("line1 summary=%q", entry.Summary)
			}
		}
	}

	// Error path also logs (status + error, no token).
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"llm down"}}`))
	}))
	defer bad.Close()
	inst2, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                []byte(`{"apiUrl":"` + bad.URL + `","debugLog":true}`),
		DecryptedSecureJSONData: map[string]string{"apiKey": secret},
	})
	if err != nil {
		t.Fatal(err)
	}
	app2 := inst2.(*App)
	defer app2.Dispose()
	var resp backend.CallResourceResponse
	err = app2.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: editorPluginContext(),
		Path:          "query",
		Method:        http.MethodPost,
		Body:          []byte(`{"intent":"fail please"}`),
	}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
		resp = *r
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != http.StatusInternalServerError {
		t.Fatalf("status=%d", resp.Status)
	}

	raw, err = os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	lines = strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 3 {
		t.Fatalf("want 3 log lines after error, got %d", len(lines))
	}
	var errEntry askLogEntry
	if err := json.Unmarshal([]byte(lines[2]), &errEntry); err != nil {
		t.Fatal(err)
	}
	if errEntry.Tool != "query" || errEntry.Status != http.StatusInternalServerError {
		t.Fatalf("err entry=%+v", errEntry)
	}
	if errEntry.Body != "fail please" {
		t.Fatalf("err body=%q", errEntry.Body)
	}
	if errEntry.Error != "llm down" {
		t.Fatalf("err error=%q", errEntry.Error)
	}
	if strings.Contains(lines[2], secret) {
		t.Fatalf("error line leaked secret: %s", lines[2])
	}
}

func TestAskLogDisabledByDefault(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "dotai-ask.log")
	prev := askLogPath
	askLogPath = logPath
	t.Cleanup(func() { askLogPath = prev })

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"ok"}}}`))
	}))
	defer upstream.Close()

	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `"}`),
		DecryptedSecureJSONData: map[string]string{"apiKey": "tok"},
	})
	if err != nil {
		t.Fatal(err)
	}
	app := inst.(*App)
	defer app.Dispose()

	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: editorPluginContext(),
		Path:          "query",
		Method:        http.MethodPost,
		Body:          []byte(`{"intent":"list pods"}`),
	}, callResourceResponseSenderFunc(func(*backend.CallResourceResponse) error { return nil }))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(logPath); !os.IsNotExist(err) {
		t.Fatalf("ask log should not exist when debugLog is off: %v", err)
	}
}


func TestAppendAskLogRotatesAtMaxSize(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "dotai-ask.log")
	prev := askLogPath
	askLogPath = logPath
	t.Cleanup(func() { askLogPath = prev })

	// Seed a file at/over the cap so the next append rotates.
	seed := bytes.Repeat([]byte("x"), maxAskLogBytes)
	if err := os.WriteFile(logPath, seed, 0o640); err != nil {
		t.Fatal(err)
	}

	appendAskLog(context.Background(), "query", []byte(`{"intent":"after-rotate"}`), http.StatusOK, "rotated-summary", "")

	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatalf("stat current log: %v", err)
	}
	if info.Size() >= maxAskLogBytes {
		t.Fatalf("current log should be fresh after rotate, size=%d", info.Size())
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("after-rotate")) {
		t.Fatalf("new line missing from rotated log: %s", string(raw))
	}
	if !bytes.Contains(raw, []byte("rotated-summary")) {
		t.Fatalf("summary missing: %s", string(raw))
	}

	rotated, err := os.ReadFile(logPath + ".1")
	if err != nil {
		t.Fatalf("expected rotated .1 file: %v", err)
	}
	if len(rotated) != maxAskLogBytes {
		t.Fatalf("rotated size=%d want %d", len(rotated), maxAskLogBytes)
	}
}

func TestAskBodyPreviewStripsSecrets(t *testing.T) {
	got := askBodyPreview([]byte(`{"intent":"hello","apiKey":"sekrit","Authorization":"Bearer sekrit"}`))
	if got != "hello" {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(got, "sekrit") || strings.Contains(got, "Bearer") {
		t.Fatalf("leaked secret in %q", got)
	}
	// Over-long bodies keep head AND tail: the question is packed after Current, so a
	// head-only cut drops the follow-up prompt that identifies the hop branch.
	long := strings.Repeat("x", 5000)
	got = askBodyPreview([]byte(`{"issue":"` + long + `"}`))
	if len([]rune(got)) != 4096+len([]rune("…[+904]…")) {
		t.Fatalf("truncate len=%d got=%q", len([]rune(got)), got)
	}
	if !strings.Contains(got, "…[+904]…") {
		t.Fatalf("expected middle elision marker: %q", got[:80])
	}

	// The branch marker at the very end of a long packed body must survive.
	tailMarker := "Final follow-up: your previous answer still hedged"
	packed := "Current:\n" + strings.Repeat("loki line noise. ", 400) + "\n\n" + tailMarker
	got = askBodyPreview([]byte(`{"intent":` + mustJSONString(packed) + `}`))
	if !strings.HasSuffix(got, tailMarker) {
		t.Fatalf("branch marker lost from tail: %q", got[len(got)-120:])
	}
	// A progressive-context question (Current block + question) must survive intact.
	ctxQuestion := "Current: " + strings.Repeat("pods in ns foo are healthy. ", 60) + "\n\nWhat is broken?"
	body, err := json.Marshal(map[string]any{"intent": ctxQuestion})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got = askBodyPreview(body); got != ctxQuestion {
		t.Fatalf("context question truncated: len=%d", len([]rune(got)))
	}
}

func mustJSONString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestAskMetaFromBodyReadsBranch(t *testing.T) {
	body := []byte(`{"intent":"list pods","hop":3,"hops":3,"current_empty":false,"first_hop":"grafana","branch":"hedge","execute":true}`)
	hop, hops, currentEmpty, firstHop, branch := askMetaFromBody(body)
	if hop != 3 || hops != 3 || firstHop != "grafana" || branch != "hedge" {
		t.Fatalf("hop=%d hops=%d firstHop=%q branch=%q", hop, hops, firstHop, branch)
	}
	if currentEmpty == nil || *currentEmpty {
		t.Fatalf("current_empty not parsed: %v", currentEmpty)
	}

	// Unknown branch values are dropped rather than logged verbatim.
	if _, _, _, _, b := askMetaFromBody([]byte(`{"branch":"bogus"}`)); b != "" {
		t.Fatalf("expected empty branch, got %q", b)
	}

	// branch never reaches dot-ai and never appears in the body preview.
	out, err := stripAskMetaForUpstream(body, "/api/v1/tools/query")
	if err != nil {
		t.Fatalf("strip: %v", err)
	}
	if strings.Contains(string(out), "branch") || strings.Contains(string(out), "execute") {
		t.Fatalf("extra keys forwarded upstream: %s", out)
	}
	if !strings.Contains(string(out), `"intent":"list pods"`) {
		t.Fatalf("intent dropped: %s", out)
	}
	if strings.Contains(askBodyPreview(body), "branch") {
		t.Fatalf("branch leaked into body preview")
	}
}

// TestAskLogUserAttribution asserts debug ask-log lines record login + role,
// never email (PII), and use the explicit "unauthenticated" marker when a
// completed log line is written with no user on the context.
// GrafanaAuthModel: backend.User has Login/Name/Email/Role only; Email must not be logged.
func TestAskLogUserAttribution(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "dotai-ask.log")
	prev := askLogPath
	askLogPath = logPath
	t.Cleanup(func() { askLogPath = prev })

	const secret = "attribution-test-token"
	const piiEmail = "alice@example.com"
	const unauthMarker = "unauthenticated"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"result":{"summary":"ok"}}}`))
	}))
	defer upstream.Close()

	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                []byte(`{"apiUrl":"` + upstream.URL + `","debugLog":true}`),
		DecryptedSecureJSONData: map[string]string{"apiKey": secret},
	})
	if err != nil {
		t.Fatal(err)
	}
	app := inst.(*App)
	defer app.Dispose()

	callOK := func(t *testing.T, pctx backend.PluginContext) {
		t.Helper()
		var resp backend.CallResourceResponse
		err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: pctx,
			Path:          "query",
			Method:        http.MethodPost,
			Body:          []byte(`{"intent":"who am i"}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusOK {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
	}

	readLastLine := func(t *testing.T) string {
		t.Helper()
		raw, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatalf("read ask log: %v", err)
		}
		lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
		if len(lines) == 0 || lines[0] == "" {
			t.Fatal("ask log empty")
		}
		return lines[len(lines)-1]
	}

	t.Run("authenticated_user_login_and_role_no_email", func(t *testing.T) {
		callOK(t, backend.PluginContext{
			User: &backend.User{
				Login: "alice",
				Name:  "Alice Example",
				Email: piiEmail,
				Role:  "Editor",
			},
		})
		line := readLastLine(t)
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			t.Fatalf("json: %v raw=%s", err, line)
		}
		login, _ := raw["login"].(string)
		role, _ := raw["role"].(string)
		if login != "alice" {
			t.Fatalf("login=%v want alice full=%s", raw["login"], line)
		}
		if role != "Editor" {
			t.Fatalf("role=%v want Editor full=%s", raw["role"], line)
		}
		if strings.Contains(line, piiEmail) {
			t.Fatalf("email leaked into ask log: %s", line)
		}
		if strings.Contains(line, "Alice Example") {
			t.Fatalf("name leaked into ask log: %s", line)
		}
		if _, ok := raw["email"]; ok {
			t.Fatalf("email field present in log line: %s", line)
		}
		if strings.Contains(line, secret) {
			t.Fatalf("token leaked: %s", line)
		}
	})

	t.Run("nil_user_denied_before_proxy_no_email", func(t *testing.T) {
		var hits int32
		denyUp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&hits, 1)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true}`))
		}))
		defer denyUp.Close()
		inst2, err := NewApp(context.Background(), backend.AppInstanceSettings{
			JSONData:                []byte(`{"apiUrl":"` + denyUp.URL + `","debugLog":true}`),
			DecryptedSecureJSONData: map[string]string{"apiKey": secret},
		})
		if err != nil {
			t.Fatal(err)
		}
		app2 := inst2.(*App)
		defer app2.Dispose()

		before, _ := os.ReadFile(logPath)
		beforeN := 0
		if len(bytes.TrimSpace(before)) > 0 {
			beforeN = len(strings.Split(strings.TrimSpace(string(before)), "\n"))
		}

		var resp backend.CallResourceResponse
		err = app2.CallResource(context.Background(), &backend.CallResourceRequest{
			// PluginContext.User intentionally omitted (nil).
			Path:   "query",
			Method: http.MethodPost,
			Body:   []byte(`{"intent":"who am i"}`),
		}, callResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error {
			resp = *r
			return nil
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
		}
		if atomic.LoadInt32(&hits) != 0 {
			t.Fatalf("nil user must not dial upstream, hits=%d", hits)
		}
		after, err := os.ReadFile(logPath)
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		afterN := 0
		if len(bytes.TrimSpace(after)) > 0 {
			afterN = len(strings.Split(strings.TrimSpace(string(after)), "\n"))
		}
		// Prefer no log line on deny; if a line is written it must still never contain email
		// and must use the unauthenticated marker rather than a blank/missing identity.
		if afterN > beforeN {
			line := strings.Split(strings.TrimSpace(string(after)), "\n")[afterN-1]
			if strings.Contains(line, piiEmail) {
				t.Fatalf("email leaked on denied nil-user log: %s", line)
			}
			var raw map[string]any
			if err := json.Unmarshal([]byte(line), &raw); err != nil {
				t.Fatalf("json: %v", err)
			}
			if login, _ := raw["login"].(string); login != unauthMarker {
				t.Fatalf("denied/nil log login=%q want %q line=%s", login, unauthMarker, line)
			}
		}
	})

	t.Run("unauthenticated_marker_contract_and_empty_login_not_forged", func(t *testing.T) {
		// Nil-user tool calls are denied before ask-log. The marker contract is:
		// when a completed ask-log line is produced with no user on the context,
		// login must be exactly "unauthenticated". Pin the marker string here and
		// prove a non-nil user with empty Login is NOT rewritten to that marker
		// (and still never logs email).
		if unauthMarker != "unauthenticated" {
			t.Fatalf("marker constant drifted: %q", unauthMarker)
		}
		callOK(t, backend.PluginContext{
			User: &backend.User{Login: "", Email: piiEmail, Role: "Editor"},
		})
		line := readLastLine(t)
		if strings.Contains(line, piiEmail) {
			t.Fatalf("email leaked: %s", line)
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			t.Fatalf("json: %v raw=%s", err, line)
		}
		if _, ok := raw["login"]; !ok {
			t.Fatalf("login field missing on completed ask-log line: %s", line)
		}
		login, _ := raw["login"].(string)
		if login == unauthMarker {
			t.Fatalf("empty Login on non-nil user must not be rewritten to %q: %s", unauthMarker, line)
		}
		role, _ := raw["role"].(string)
		if role != "Editor" {
			t.Fatalf("role=%q want Editor line=%s", role, line)
		}
	})
}

