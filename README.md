<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" alt="DB Client" />

# DB Client

**A fast, modern desktop client for PostgreSQL and MySQL.**
Built with Rust and Tauri — small, native and quick to start.

[Website](https://madnesscode.github.io/dbclient/) · [Download](https://github.com/MadnessCODE/dbclient/releases/latest)

![Status: beta](https://img.shields.io/badge/status-beta-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

</div>

> [!WARNING]
> **DB Client is in beta.** It is used daily during development, but expect rough edges and breaking changes.
> Be careful on production databases and please [report issues](https://github.com/MadnessCODE/dbclient/issues).

## Features

**Connections**
- PostgreSQL and MySQL / MariaDB, with SSL and **SSH tunnels** (password or key, host key verification)
- Passwords stored in the system keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service)
- Projects to group connections, colors and environment labels (DEV / STAGING / PROD)
- **Production guard**: statements that change data ask for confirmation on PROD connections

**Querying**
- SQL editor (Monaco) with autocomplete for tables, columns and aliases
- Run the statement under the cursor, a selection or the whole script; cancel long queries
- Results grid that stays fast with large results, sorting, NULL clearly shown, foreign-key links to related rows
- Per-tab history and EXPLAIN

**Editing data**
- Edit cells inline, multi-select and set many cells at once, add / duplicate / delete rows
- Date & time picker (time zones, PostgreSQL ±infinity), enum/set pickers, JSON viewer
- All changes are previewed as SQL and saved in one transaction

**Schema**
- Schema tree with search, table sizes and right-click actions
- Structure editor: columns, indexes, foreign keys, with ALTER preview

**Import & export**
- Export to CSV, Excel (real .xlsx), JSON and SQL INSERT — including all rows from the database, not just the loaded page
- Import SQL dumps (mysqldump, pg_dump plain, `.sql.gz`) **in parallel** over several connections
- Import CSV, Excel and JSON into a new or existing table, with type detection and column mapping
- Long jobs run in the background with progress, notifications and a task list

**Administration**
- Users & privileges: create users/roles, passwords, database / schema / table / view level grants, quick presets
- Processes: live list of sessions and running queries, lock waits (who blocks whom), cancel a query or kill a connection

## Download

**Windows:** download the installer from the [latest release](https://github.com/MadnessCODE/dbclient/releases/latest) and run it: `x64-setup.exe` for most PCs, `arm64-setup.exe` for Windows on ARM. It installs for the current user (no admin rights needed), and the app updates itself when a new version is out.

The installer isn't code-signed yet, so Windows SmartScreen may show a warning: click **More info** → **Run anyway**.

macOS and Linux builds are coming; until then, build from source (below).

## Build from source

Requirements:
- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20 or newer
- Tauri system dependencies for your OS — see [Tauri prerequisites](https://tauri.app/start/prerequisites/)

```bash
git clone https://github.com/MadnessCODE/dbclient.git
cd dbclient
npm install
npm run tauri dev     # run in development mode
npm run tauri build   # build an installer for your platform
```

## Tech stack

- **Backend:** Rust, [Tauri 2](https://tauri.app/), [sqlx](https://github.com/launchbadge/sqlx), [russh](https://github.com/Eugeny/russh)
- **Frontend:** React 19, TypeScript, Tailwind CSS, Monaco Editor, Zustand

## Contributing

Bug reports and ideas are welcome — open an [issue](https://github.com/MadnessCODE/dbclient/issues).
Pull requests too; for bigger changes please open an issue first so we can talk about it.

## License

[MIT](LICENSE) © 2026 [MadnessCODE](https://github.com/madnesscode)
