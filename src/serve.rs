//! A local HTTP server for the viewer.
//!
//! Deliberately minimal: one client, one machine, no framework. The page
//! polls `/api/version` for a counter the file watcher bumps, which is enough
//! live-reload for a dev tool and avoids the plumbing that SSE would need.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use notify::{EventKind, RecursiveMode, Watcher};
use tiny_http::{Header, Request, Response, Server};

pub fn run(
    crate_root: &Path,
    port: u16,
    scope: &crate::extract::Scope,
    ui_dir: Option<PathBuf>,
) -> Result<()> {
    let crate_root = crate::ui::crate_root(crate_root)?;
    let ui_dir = crate::ui::dir(ui_dir)?;

    let version = Arc::new(AtomicU64::new(1));
    let _watcher = watch_sources(&crate_root, Arc::clone(&version))?;

    let server = Server::http(("127.0.0.1", port))
        .map_err(|e| anyhow::anyhow!("could not bind 127.0.0.1:{port}: {e}"))?;
    eprintln!(
        "portray: http://127.0.0.1:{port}  ({}{})",
        crate_root.display(),
        if scope.is_everything() {
            String::new()
        } else {
            format!(", module {}", scope.describe())
        }
    );

    for request in server.incoming_requests() {
        if let Err(err) = handle(request, &crate_root, &ui_dir, scope, &version) {
            eprintln!("portray: {err:#}");
        }
    }
    Ok(())
}

fn handle(
    request: Request,
    crate_root: &Path,
    ui_dir: &Path,
    scope: &crate::extract::Scope,
    version: &AtomicU64,
) -> Result<()> {
    let url = request.url().split('?').next().unwrap_or("/").to_string();
    match url.as_str() {
        "/api/version" => {
            let body = format!("{{\"version\":{}}}", version.load(Ordering::Relaxed));
            respond(request, 200, "application/json", body.into_bytes())
        }
        "/api/graph" => {
            let body = match crate::extract::extract(crate_root, scope) {
                Ok(graph) => serde_json::to_vec(&graph)?,
                Err(err) => {
                    let message = serde_json::to_string(&err.to_string())?;
                    return respond(
                        request,
                        500,
                        "application/json",
                        format!("{{\"error\":{message}}}").into_bytes(),
                    );
                }
            };
            respond(request, 200, "application/json", body)
        }
        _ => serve_static(request, ui_dir, &url),
    }
}

fn serve_static(request: Request, ui_dir: &Path, url: &str) -> Result<()> {
    let relative = url.trim_start_matches('/');
    // Reject anything that tries to climb out of the ui directory.
    let candidate = if relative.is_empty() || relative.contains("..") {
        ui_dir.join("index.html")
    } else {
        ui_dir.join(relative)
    };
    let path = if candidate.is_file() {
        candidate
    } else {
        // Single-page app: unknown paths fall back to the shell.
        ui_dir.join("index.html")
    };

    let content_type = match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };
    let body = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    respond(request, 200, content_type, body)
}

fn respond(request: Request, status: u16, content_type: &str, body: Vec<u8>) -> Result<()> {
    let header = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
        .map_err(|_| anyhow::anyhow!("bad content type"))?;
    let response = Response::from_data(body)
        .with_status_code(status)
        .with_header(header);
    request.respond(response)?;
    Ok(())
}

/// Bumps `version` whenever a `.rs` file under the crate changes.
fn watch_sources(crate_root: &Path, version: Arc<AtomicU64>) -> Result<impl Watcher> {
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        // Reads count as events too, and serving /api/graph reads every
        // source file — without this the server would bump its own version
        // on each request and the page would reload forever.
        let changes_something = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        );
        let touches_rust = event
            .paths
            .iter()
            .any(|p| p.extension().and_then(|e| e.to_str()) == Some("rs"));
        if changes_something && touches_rust {
            version.fetch_add(1, Ordering::Relaxed);
        }
    })?;
    watcher.watch(&crate_root.join("src"), RecursiveMode::Recursive)?;
    // Give the watcher a moment to settle before the first request lands.
    std::thread::sleep(Duration::from_millis(50));
    Ok(watcher)
}
