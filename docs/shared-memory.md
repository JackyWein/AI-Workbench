# Shared Markdown memory

AI Workbench can attach an Obsidian vault as a local shared memory. A vault is
an ordinary folder of Markdown notes; Obsidian may be open while agents use it,
but the app does not depend on Obsidian running.

In **Connectors → Discover**, choose **Shared Obsidian memory → Choose vault**
and select the vault folder. This saves one global MCP connector and connects
it immediately. The connection appears under **Yours**. Changing the vault
replaces that connector's folder. Choose a vault whose notes may be read by
every agent with tool access in AI Workbench.

The connector offers three tools:

| Tool | Result |
|---|---|
| `memory_search` | Up to 20 matching note names and short excerpts |
| `memory_read` | Up to 12,000 characters from one selected note, with an offset for more |
| `memory_add` | A new uniquely named note under `AI Workbench Memory/`; existing notes are not overwritten |

These tools use the existing capability-based connector bridge. Sessions and
team members whose provider supports MCP can connect directly. Sessions whose
provider supports tool calls can use host-mediated tools. Terminal agents get
the globally available connector through the existing workspace access path.
A tool with neither capability cannot use this memory; its ordinary terminal
can still access files if its own permissions and working directory allow it.
The Connectors screen reports connection status, and provider capability still
determines whether a particular agent can call the tools.

Search scans Markdown files within the vault and skips hidden directories,
symbolic links and files larger than 1 MB. Read validates the requested
relative path and returns bounded slices. Add writes a new note only. Obsidian
and other editors see these files normally. The app never automatically sends
an entire vault to a model.

This can save tokens when an agent searches for a specific fact and reads only
the relevant note. A Markdown vault is not inherently more token efficient
than SQLite: a targeted database query can be just as small or smaller.
Keeping notes short and searchable matters more than the storage format.
The app's session and team history stays in its database; the vault is shared
knowledge that agents can choose to retrieve.
