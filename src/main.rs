//! Item-level dependency explorer for Rust crates.
//!
//! `emit` writes the graph model as JSON; `serve` hosts the interactive
//! viewer, which does all the filtering and draws the diagram itself; `export`
//! writes that same viewer out as a static site.
//!
//! Nothing here is specific to the crate it lives in: point it at any Rust
//! crate root.

mod export;
mod extract;
mod model;
mod resolve;
mod serve;
mod ui;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

const DEFAULT_PORT: u16 = 7878;

#[derive(Parser)]
#[command(
    name = "cargo-portray",
    // Installed, this runs as `cargo portray`; that is the spelling the help
    // should teach, not the hyphenated name cargo dispatches on.
    bin_name = "cargo portray",
    about,
    version,
    after_help = "  cargo portray                    (serve is the default)\n  \
                  cargo portray serve ~/src/mycrate\n  \
                  cargo portray emit . -o graph.json\n  \
                  cargo portray export . -o site\n  \
                  cargo portray serve . -m actions   (read one module of a huge crate)\n\n\
                  From a checkout of this crate, run it through cargo with a `--` \
                  separator, which is what tells cargo the rest is not for it:\n  \
                  cargo run -- serve ../.."
)]
struct Cli {
    /// Defaults to `serve`, which is what you almost always want.
    #[command(subcommand)]
    command: Option<Command>,

    /// Crate root, when no subcommand is given.
    #[arg(default_value = ".")]
    crate_root: PathBuf,

    #[arg(short, long, default_value_t = DEFAULT_PORT)]
    port: u16,

    /// Read only this module and what is inside it; repeatable.
    #[arg(short, long = "module", value_name = "PATH")]
    modules: Vec<String>,

    /// Directory holding the viewer; defaults to this crate's `ui`.
    #[arg(long)]
    ui: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Write the dependency graph as JSON.
    Emit {
        /// Crate root (the directory holding Cargo.toml and src/).
        #[arg(default_value = ".")]
        crate_root: PathBuf,
        /// Read only this module and what is inside it, `actions` or
        /// `actions::power`; repeatable. Everything outside is not parsed at
        /// all, so it is as invisible as another crate.
        #[arg(short, long = "module", value_name = "PATH")]
        modules: Vec<String>,
        /// Output file; `-` writes to stdout.
        #[arg(short, long, default_value = "graph.json")]
        out: String,
        /// Indent the JSON.
        #[arg(long)]
        pretty: bool,
    },
    /// Serve the interactive viewer on localhost.
    Serve {
        /// Crate root (the directory holding Cargo.toml and src/).
        #[arg(default_value = ".")]
        crate_root: PathBuf,
        #[arg(short, long, default_value_t = DEFAULT_PORT)]
        port: u16,
        /// Read only this module and what is inside it, `actions` or
        /// `actions::power`; repeatable. Everything outside is not parsed at
        /// all, so it is as invisible as another crate.
        #[arg(short, long = "module", value_name = "PATH")]
        modules: Vec<String>,
        /// Directory holding the viewer; defaults to this crate's `ui`.
        #[arg(long)]
        ui: Option<PathBuf>,
    },
    /// Write the viewer out as a static site, model included.
    Export {
        /// Crate root (the directory holding Cargo.toml and src/).
        #[arg(default_value = ".")]
        crate_root: PathBuf,
        /// Directory to write the site into; created if it does not exist.
        #[arg(short, long, default_value = "site")]
        out: PathBuf,
        /// Read only this module and what is inside it, `actions` or
        /// `actions::power`; repeatable. Everything outside is not parsed at
        /// all, so it is as invisible as another crate.
        #[arg(short, long = "module", value_name = "PATH")]
        modules: Vec<String>,
        /// Directory holding the viewer; defaults to this crate's `ui`.
        #[arg(long)]
        ui: Option<PathBuf>,
    },
}

/// Drops the subcommand name cargo echoes back.
///
/// `cargo portray serve .` finds `cargo-portray` on PATH and runs it as
/// `cargo-portray portray serve .`, so the name arrives twice. Only the first
/// argument is considered, which leaves a directory that happens to be called
/// `portray` reachable as `cargo portray ./portray`.
fn argv() -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "portray") {
        args.remove(1);
    }
    args
}

fn main() -> Result<()> {
    let cli = Cli::parse_from(argv());
    let command = cli.command.unwrap_or(Command::Serve {
        crate_root: cli.crate_root,
        port: cli.port,
        modules: cli.modules,
        ui: cli.ui,
    });

    match command {
        Command::Emit {
            crate_root,
            modules,
            out,
            pretty,
        } => {
            let graph = extract::extract(&crate_root, &extract::Scope::new(&modules)?)?;
            let json = if pretty {
                serde_json::to_string_pretty(&graph)?
            } else {
                serde_json::to_string(&graph)?
            };
            if out == "-" {
                println!("{json}");
            } else {
                std::fs::write(&out, json)?;
                eprintln!(
                    "wrote {out}: {} nodes, {} edges",
                    graph.nodes.len(),
                    graph.edges.len()
                );
            }
            Ok(())
        }
        Command::Serve {
            crate_root,
            port,
            modules,
            ui,
        } => serve::run(&crate_root, port, &extract::Scope::new(&modules)?, ui),
        Command::Export {
            crate_root,
            out,
            modules,
            ui,
        } => export::run(&crate_root, &out, &extract::Scope::new(&modules)?, ui),
    }
}
