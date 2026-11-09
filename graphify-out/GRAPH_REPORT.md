# Graph Report - server  (2026-11-09)

## Corpus Check
- Corpus is ~26,842 words - fits in a single context window. You may not need a graph.

## Summary
- 480 nodes · 944 edges · 19 communities (18 shown, 1 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 84 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Controller Core and Streaming
- Engine, Auth and Task Runner
- GRBL Line Parsers
- Constants and Builtin Commands
- Units and CNCjs Autolevel
- FluidNC Machine Config
- Watch Directory Monitor
- Job File Storage
- Typed Backend Entry
- Sender Protocols
- Expression Evaluator
- XModem Upload
- FluidNC Serial Exchange
- Immutable Store
- Serial Connection
- Backend README Notes
- Session and JWT Auth
- Config Store
- Exclusive Controller Interface

## God Nodes (most connected - your core abstractions)
1. `GrblController` - 19 edges
2. `saveMachineConfig()` - 16 edges
3. `Feeder` - 14 edges
4. `ExchangeError` - 14 edges
5. `Sender` - 13 edges
6. `GrblRunner` - 12 edges
7. `upload()` - 12 edges
8. `SPCharCounting` - 11 edges
9. `SerialConnection` - 11 edges
10. `Workflow` - 10 edges

## Surprising Connections (you probably didn't know these)
- `handleMachineConfig()` --calls--> `isAuthorized()`  [EXTRACTED]
  fluidnc/machineConfig.ts → session.ts
- `FluidncController` --references--> `RawPort`  [EXTRACTED]
  fluidnc/exchange.ts → fluidnc/xmodem.ts
- `readBackup()` --calls--> `ExchangeError`  [EXTRACTED]
  fluidnc/machineConfig.ts → fluidnc/exchange.ts
- `readJson()` --calls--> `ExchangeError`  [EXTRACTED]
  fluidnc/machineConfig.ts → fluidnc/exchange.ts
- `saveMachineConfig()` --calls--> `ExchangeError`  [EXTRACTED]
  fluidnc/machineConfig.ts → fluidnc/exchange.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Shell command execution path guarded by security rule** — cnc_readme_kinetiqrc, cnc_lib_eventtrigger, cnc_services_taskrunner_index_run, cnc_readme_security_rule [EXTRACTED 1.00]
- **Exclusive mode for XModem upload** — cnc_controllers_grbl_grblcontroller_setexclusive, cnc_readme_xmodem_upload, cnc_readme_feeder, cnc_readme_query_timer [EXTRACTED 1.00]
- **Backend startup: backend.ts loads rc file and constructs CNCEngine with Grbl** — backend, cnc_readme_kinetiqrc, cnc_services_cncengine_cncengine, cnc_controllers_grbl_grblcontroller [INFERRED 0.85]

## Communities (19 total, 1 thin omitted)

### Community 0 - "Controller Core and Streaming"
Cohesion: 0.06
Nodes (8): GrblController, GrblRunner, delay(), Feeder, MessageSlot, Sender, SerialConnection, Workflow

### Community 1 - "Engine, Auth and Task Runner"
Cohesion: 0.05
Nodes (19): loadBackend(), authorizeIPAddress(), validateUser(), whitelist, EventTrigger, levels, logger, rc file ~/.kinetiqrc (events, ports, secret) (+11 more)

### Community 2 - "GRBL Line Parsers"
Cohesion: 0.07
Nodes (19): GRBL_ACTIVE_STATE_ALARM, GRBL_ACTIVE_STATE_IDLE, GRBL_MODAL_GROUPS, GrblLineParser, GrblLineParserResultAlarm, GrblLineParserResultEcho, GrblLineParserResultError, GrblLineParserResultFeedback (+11 more)

### Community 3 - "Constants and Builtin Commands"
Cohesion: 0.07
Nodes (33): BUILTIN_COMMAND_MSG, BUILTIN_COMMAND_WAIT, GLOBAL_OBJECTS, IMPERIAL_UNITS, WRITE_SOURCE_CLIENT, WRITE_SOURCE_FEEDER, WRITE_SOURCE_SENDER, WRITE_SOURCE_SERVER (+25 more)

### Community 4 - "Units and CNCjs Autolevel"
Cohesion: 0.14
Nodes (25): METRIC_UNITS, in2mm(), mapPositionToImperialUnits(), mapPositionToMetricUnits(), mapPositionToUnits(), mapValueToImperialUnits(), mapValueToMetricUnits(), mapValueToUnits() (+17 more)

### Community 5 - "FluidNC Machine Config"
Cohesion: 0.11
Nodes (26): activeFilename(), BACKUP_DIR, BackupInfo, BootLogLevel, comparable(), compare(), ConfigDifference, ControllerStore (+18 more)

### Community 6 - "Watch Directory Monitor"
Cohesion: 0.11
Nodes (14): FSMonitor, claimName(), createLimitStream(), deleteFile(), emitter, failure(), monitor, NO_HARDLINK_SUPPORT (+6 more)

### Community 7 - "Job File Storage"
Cohesion: 0.17
Nodes (25): ALLOWED_EXTENSIONS, countLines(), exclusive(), fail(), gcodeFile(), handleJobs(), indexFile, isRun() (+17 more)

### Community 8 - "Typed Backend Entry"
Cohesion: 0.10
Nodes (6): closeAllControllers(), CNCBackend, CNCControllerLike, CNCEngineInstance, ConfigStore, ImmutableStore

### Community 9 - "Sender Protocols"
Cohesion: 0.11
Nodes (4): SP_TYPE_CHAR_COUNTING, SP_TYPE_SEND_RESPONSE, SPCharCounting, SPSendResponse

### Community 10 - "Expression Evaluator"
Cohesion: 0.20
Nodes (13): evaluateAssignmentExpression(), isComputedMemberExpression(), isStaticMemberExpression(), log, lookupObjectPath(), walkAssignmentExpression(), walkSequenceExpression(), evaluateExpression() (+5 more)

### Community 11 - "XModem Upload"
Cohesion: 0.20
Nodes (5): ByteReader, crc16(), RawPort, write(), xmodemSend()

### Community 12 - "FluidNC Serial Exchange"
Cohesion: 0.23
Nodes (11): assertIdle(), cleanSettings(), ControllerStore, ExchangeError, exclusive(), getOpenController(), parseBootLog(), parseFs() (+3 more)

### Community 13 - "Immutable Store"
Cohesion: 0.22
Nodes (3): ImmutableStore, defaultState, store

### Community 14 - "Serial Connection"
Cohesion: 0.20
Nodes (6): DATABITS, defaultSettings, FLOWCONTROLS, PARITY, STOPBITS, toIdent()

### Community 15 - "Backend README Notes"
Cohesion: 0.25
Nodes (7): CNCjs MIT LICENSE, Kinetiq CNC backend README, docs/API_REFERENCE.md, CNCjs 1.11.5 (CNCJS-fork commit a3922a1bf), Kinetiq CNC backend (src/server/cnc), Not carried over: Express app, REST API, i18n, views, Marlin/Smoothie/TinyG, CNCjs CLI, CNCjs Socket.IO 2 protocol

### Community 16 - "Session and JWT Auth"
Cohesion: 0.32
Nodes (6): CNCSettings, handleSession(), isAuthorized(), isLoopbackHost(), LOOPBACK_HOSTS, SESSION_PATH

### Community 18 - "Exclusive Controller Interface"
Cohesion: 0.53
Nodes (3): exchange(), FluidncController, upload()

## Knowledge Gaps
- **6 isolated node(s):** `tool:change routine and lasertest (removed)`, `Settings editor XModem upload`, `Feeder`, `Query timer (?/$G status polling)`, `Not carried over: Express app, REST API, i18n, views, Marlin/Smoothie/TinyG, CNCjs CLI` (+1 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 153 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `GrblController` connect `Controller Core and Streaming` to `Engine, Auth and Task Runner`, `Constants and Builtin Commands`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **What connects `tool:change routine and lasertest (removed)`, `Settings editor XModem upload`, `Feeder` to the rest of the system?**
  _6 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Controller Core and Streaming` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._
- **Why does `SPCharCounting` connect `Sender Protocols` to `Controller Core and Streaming`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Should `Engine, Auth and Task Runner` be split into smaller, more focused modules?**
  _Cohesion score 0.05454545454545454 - nodes in this community are weakly interconnected._
- **Why does `Kinetiq CNC backend README` connect `Backend README Notes` to `Engine, Auth and Task Runner`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Should `GRBL Line Parsers` be split into smaller, more focused modules?**
  _Cohesion score 0.06980392156862746 - nodes in this community are weakly interconnected._