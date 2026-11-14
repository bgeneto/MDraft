mod engine;
mod protocol;
mod security;
mod world;

use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use engine::{ServiceConfig, ServiceEngine, TYPST_CRATE_VERSION};
use protocol::{FramingMode, PROTOCOL_VERSION, Request, Response, read_packet, write_packet};

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn parse_args() -> Result<(ServiceConfig, FramingMode, u64), String> {
    let mut args = std::env::args().skip(1);
    let mut root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut framing = FramingMode::Packet;
    let mut load_system_fonts = true;
    let mut enable_local_packages = true;
    let mut max_cache_age = 30usize;
    let mut max_rss_mb = 512u64;
    let mut idle_timeout_secs = 0u64;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--version" | "-V" => {
                println!(
                    "mdraft-typst-service {} (typst {}, protocol {})",
                    env!("CARGO_PKG_VERSION"),
                    TYPST_CRATE_VERSION,
                    PROTOCOL_VERSION
                );
                std::process::exit(0);
            }
            "--protocol-version" => {
                println!("{PROTOCOL_VERSION}");
                std::process::exit(0);
            }
            "--stdio" => {}
            "--root" => {
                let val = args.next().ok_or("--root requires a path")?;
                root = PathBuf::from(val);
            }
            "--framing" => {
                let val = args.next().ok_or("--framing requires `packet` or `ndjson`")?;
                framing = match val.as_str() {
                    "packet" => FramingMode::Packet,
                    "ndjson" => FramingMode::Ndjson,
                    other => return Err(format!("unknown framing mode `{other}`")),
                };
            }
            "--no-system-fonts" => load_system_fonts = false,
            "--no-packages" => enable_local_packages = false,
            "--max-cache-age" => {
                let val = args.next().ok_or("--max-cache-age requires a number")?;
                max_cache_age = val
                    .parse()
                    .map_err(|e| format!("invalid --max-cache-age `{val}`: {e}"))?;
            }
            "--max-rss-mb" => {
                let val = args.next().ok_or("--max-rss-mb requires a number")?;
                max_rss_mb = val
                    .parse()
                    .map_err(|e| format!("invalid --max-rss-mb `{val}`: {e}"))?;
            }
            "--idle-timeout" => {
                let val = args.next().ok_or("--idle-timeout requires seconds")?;
                idle_timeout_secs = val
                    .parse()
                    .map_err(|e| format!("invalid --idle-timeout `{val}`: {e}"))?;
            }
            other => return Err(format!("unknown argument `{other}`")),
        }
    }

    Ok((
        ServiceConfig {
            root,
            load_system_fonts,
            enable_local_packages,
            max_cache_age,
            max_rss_mb,
        },
        framing,
        idle_timeout_secs,
    ))
}

fn spawn_idle_watchdog(
    idle_timeout_secs: u64,
    last_activity_ms: Arc<AtomicU64>,
    in_request: Arc<AtomicBool>,
) {
    if idle_timeout_secs == 0 {
        return;
    }
    let timeout_ms = idle_timeout_secs.saturating_mul(1000);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if in_request.load(Ordering::Acquire) {
            continue;
        }
        let elapsed = now_epoch_ms().saturating_sub(last_activity_ms.load(Ordering::Acquire));
        if elapsed >= timeout_ms && !in_request.load(Ordering::Acquire) {
            std::process::exit(0);
        }
    });
}

fn main() {
    let (config, framing, idle_timeout_secs) = match parse_args() {
        Ok(parsed) => parsed,
        Err(msg) => {
            eprintln!("mdraft-typst-service: {msg}");
            std::process::exit(2);
        }
    };

    let last_activity_ms = Arc::new(AtomicU64::new(now_epoch_ms()));
    let in_request = Arc::new(AtomicBool::new(false));
    spawn_idle_watchdog(idle_timeout_secs, last_activity_ms.clone(), in_request.clone());

    let mut engine = ServiceEngine::new(config);
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    match framing {
        FramingMode::Packet => loop {
            match read_packet(&mut reader) {
                Ok(None) => break,
                Ok(Some((hdr, body))) => {
                    in_request.store(true, Ordering::Release);
                    let should_exit = match serde_json::from_slice::<Request>(&hdr) {
                        Ok(req) => {
                            let (resp, payload, exit_now) =
                                engine.handle_request(req, Some(body), false);
                            let json = serde_json::to_vec(&resp).unwrap_or_else(|e| {
                                serde_json::to_vec(&Response::err(0, e.to_string())).unwrap()
                            });
                            if write_packet(&mut writer, &json, &payload).is_err() {
                                in_request.store(false, Ordering::Release);
                                break;
                            }
                            exit_now
                        }
                        Err(err) => {
                            let json = serde_json::to_vec(&Response::err(
                                0,
                                format!("invalid request JSON: {err}"),
                            ))
                            .unwrap();
                            if write_packet(&mut writer, &json, &[]).is_err() {
                                in_request.store(false, Ordering::Release);
                                break;
                            }
                            false
                        }
                    };
                    last_activity_ms.store(now_epoch_ms(), Ordering::Release);
                    in_request.store(false, Ordering::Release);
                    if should_exit {
                        break;
                    }
                }
                Err(err) => {
                    eprintln!("mdraft-typst-service packet read error: {err}");
                    std::process::exit(1);
                }
            }
        },
        FramingMode::Ndjson => {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let should_exit = match serde_json::from_str::<Request>(trimmed) {
                            Ok(req) => {
                                let (resp, _payload, exit_now) =
                                    engine.handle_request(req, None, true);
                                let json = serde_json::to_string(&resp).unwrap_or_else(|e| {
                                    serde_json::to_string(&Response::err(0, e.to_string())).unwrap()
                                });
                                if writeln!(writer, "{json}").is_err() || writer.flush().is_err() {
                                    break;
                                }
                                exit_now
                            }
                            Err(err) => {
                                let json = serde_json::to_string(&Response::err(
                                    0,
                                    format!("invalid request JSON: {err}"),
                                ))
                                .unwrap();
                                if writeln!(writer, "{json}").is_err() || writer.flush().is_err() {
                                    break;
                                }
                                false
                            }
                        };
                        if should_exit {
                            break;
                        }
                    }
                    Err(err) => {
                        eprintln!("mdraft-typst-service ndjson read error: {err}");
                        std::process::exit(1);
                    }
                }
            }
        }
    }
}
