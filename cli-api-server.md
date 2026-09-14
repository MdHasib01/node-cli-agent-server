# 🚀 CLI-to-API Server (Multi-CLI + LLM Model Support)

## 🎯 Objective

Build a Node.js REST API server that wraps multiple CLI tools and allows dynamic selection of:

- CLI provider (claude / agy / codex)
- LLM model (not version — model selection)

The system should:
- Accept JSON input
- Select CLI dynamically
- Select model dynamically
- Auto-confirm CLI prompts
- Return results (text/image/file)
- Track usage every 5 minutes

---

## 🧱 Tech Stack

- Node.js (>=18)
- Express.js
- child_process (spawn)
- node-cron
- dotenv
- uuid

---

## 📁 Folder Structure

server/
 ├── src/
 │   ├── routes/
 │   ├── controllers/
 │   ├── services/
 │   │   ├── cliRunner.js
 │   │   ├── cliMapper.js
 │   │   └── jobStore.js
 │   ├── jobs/
 │   │   └── usageChecker.js
 │   ├── utils/
 │   │   └── sanitizer.js
 │   ├── app.js
 │   └── server.js
 ├── outputs/
 ├── .env
 ├── package.json

---

## 🔐 Environment Variables

PORT=3000  
DEFAULT_CLI=agy  
DEFAULT_MODEL=default-model  
CLI_TIMEOUT=60000  

---

## 🧠 Request Format

```json
{
  "cli": "claude",        // optional (default: agy)
  "model": "sonnet",      // optional (default used if missing)
  "type": "image",        // image | text
  "prompt": "a futuristic city"
}
```

---

## ⚙️ CLI + Model Mapping (IMPORTANT)

### NEVER execute raw commands from user.

Create a mapper:

### cliMapper.js

Map each CLI and model safely:

Example:

claude:
  command: claude
  args: ["--model", model]

agy:
  command: agy
  args: ["--model", model]

codex:
  command: codex
  args: ["--model", model]

---

## 🔧 Command Builder Logic

Pseudo:

1. cli = req.cli || DEFAULT_CLI
2. model = req.model || DEFAULT_MODEL
3. validate cli in whitelist
4. build command using mapper
5. append task (image/text)
6. append prompt safely

Final example:

agy create image "prompt" --model sonnet --yes

---

## 📡 API Endpoints

### POST /api/generate

Handles all types:

Request:
```json
{
  "cli": "agy",
  "model": "gpt-4",
  "type": "text",
  "prompt": "Explain AI"
}
```

---

## 🔁 Usage Checker

Run every 5 minutes:

- Loop all CLIs
- Run usage command per CLI
- Store result

---

## 🛡️ Security Rules

- Whitelist CLI names ONLY
- Sanitize prompt
- No dynamic shell execution
- Use spawn (NOT exec)

---

## ⏱️ Timeout

Kill process if exceeds timeout.

---

## 📂 Output Handling

- Save files in /outputs
- Return path

---

## 🚀 Run

node src/server.js

---

## ✅ Final Goal

A scalable backend that:

- Dynamically selects CLI
- Dynamically selects LLM model
- Executes safely
- Returns output cleanly
- Tracks usage
