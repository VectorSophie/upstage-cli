# upstage-cli

upstage-cli is an agentic Terminal User Interface (TUI) powered by Upstage Solar Pro2. It provides a powerful, interactive environment for pair programming, codebase exploration, and automated task execution directly from your terminal.

## Installation

To get started, clone the repository and install the dependencies:

```bash
npm install
npm start
```

## Environment Variables

The following environment variables are essential for the operation of upstage-cli:

*   `UPSTAGE_API_KEY`: Your Upstage API key. This is required to communicate with the Solar Pro2 model.
*   `EDITOR`: The command used to open an external editor (e.g., `vim`, `nano`, `code --wait`). Defaults to `vim`.
*   `SECURITY_OVERRIDE`: Set to `true` to disable path-scoped write protection. Use with caution.

You can also create a `.env` file in the root directory to manage these variables.

## Dashboard Layout

The upstage-cli interface is divided into two main sections:

1.  **Chat (Left Pane)**: This is where you interact with the agent. You can type your requests, see the agent's responses, and view diff previews of proposed changes.
2.  **Sidebar (Right Pane)**: Provides real-time context and status:
    *   **Plan**: Shows the agent's breakdown of the current task into atomic steps.
    *   **Context**: Displays the repository map and relevant files currently in the agent's context.
    *   **Tools**: Lists recent tool executions and observations.

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Tab` | Cycle focus between Input, Chat, and Sidebar |
| `Ctrl+S` | Toggle Session Browser |
| `Ctrl+T` | Toggle Repository Map |
| `Ctrl+X` | Open current input in your external `EDITOR` |
| `Esc` | Enter Navigation Mode (use `j`/`k` to scroll chat) |
| `Esc` (Double Press) | Rewind session (undo last turn) |
| `i` | Focus Input (Insert Mode) from Navigation Mode |

## Plan Mode

Before executing complex tasks, the agent enters 'Plan Mode'. It analyzes your request and breaks it down into a series of logical steps. You can track the progress of these steps in the **Plan** tab of the Sidebar. This ensures transparency and allows you to see exactly how the agent intends to solve the problem.

## Security Policy

upstage-cli implements a path-scoped write protection policy to ensure safety. By default, the agent is only allowed to write files within the current working directory (`process.cwd()`). 

*   **Restricted Writes**: Any attempt to write outside the trusted path will be blocked unless `SECURITY_OVERRIDE=true` is set.
*   **Confirmations**: High-risk actions (like executing shell commands or writing files) require explicit user approval via an interactive dialog.

## Slash Commands

*   `/new`: Start a fresh session.
*   `/sessions`: Open the session browser.
*   `/tree`: Open the repository map.
*   `/help`: Show the in-app help message.
*   `/exit`: Exit the application.
