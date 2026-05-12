"""Whatnot giveaway timer tracker.

Tkinter GUI plus a small local HTTP server (127.0.0.1:7755). The companion
browser extension in TopLevel/extension watches Whatnot tabs for pinned
giveaways and POSTs events to /pin, which start a 5:00 countdown for that
streamer. The list auto-sorts so the soonest-ending giveaway is on top.

Manual add / pin / remove buttons still work without the extension running.
"""

import json
import queue
import threading
import time
import tkinter as tk
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from tkinter import ttk, messagebox

GIVEAWAY_SECONDS = 5 * 60
TICK_MS = 250
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 7755

# Cross-thread event queue: HTTP handler threads -> Tk main loop.
_events: "queue.Queue[dict]" = queue.Queue()


class _Handler(BaseHTTPRequestHandler):
    def _send(self, status=200, body=b""):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b'{"ok":true}')
        elif self.path == "/streamers":
            names = list(self.server.tracker_names())  # type: ignore[attr-defined]
            self._send(200, json.dumps({"streamers": names}).encode())
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, b'{"error":"bad json"}')
            return

        if self.path == "/pin":
            name = (payload.get("streamer") or "").strip()
            fp = (payload.get("fingerprint") or "").strip()
            if not name:
                self._send(400, b'{"error":"missing streamer"}')
                return
            _events.put({"type": "pin", "name": name, "fingerprint": fp})
            self._send(200, b'{"ok":true}')
        else:
            self._send(404, b'{"error":"not found"}')

    def log_message(self, *args, **kwargs):
        return  # silence stderr logging


def _start_server(get_names):
    server = ThreadingHTTPServer((SERVER_HOST, SERVER_PORT), _Handler)
    server.tracker_names = get_names  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class StreamerRow:
    """One streamer's state and widgets."""

    def __init__(self, parent, name, on_pin, on_remove):
        self.name = name
        self.deadline = None       # time.monotonic() target; None if never pinned
        self.last_fingerprint = "" # used to ignore duplicate pin events

        self.frame = ttk.Frame(parent, padding=(8, 4), relief="groove", borderwidth=1)
        self.frame.columnconfigure(0, weight=1)

        self.name_label = ttk.Label(self.frame, text=name, font=("TkDefaultFont", 11, "bold"))
        self.name_label.grid(row=0, column=0, sticky="w")

        self.timer_label = ttk.Label(self.frame, text="No active giveaway", width=22, anchor="e")
        self.timer_label.grid(row=0, column=1, padx=(8, 8))

        self.pin_btn = ttk.Button(self.frame, text="Pin", width=6, command=lambda: on_pin(self))
        self.pin_btn.grid(row=0, column=2, padx=(0, 4))

        self.remove_btn = ttk.Button(self.frame, text="Remove", width=8, command=lambda: on_remove(self))
        self.remove_btn.grid(row=0, column=3)

    def start_timer(self):
        self.deadline = time.monotonic() + GIVEAWAY_SECONDS

    def remaining(self):
        if self.deadline is None:
            return None
        return self.deadline - time.monotonic()

    def refresh(self):
        rem = self.remaining()
        if rem is None:
            self.timer_label.config(text="No active giveaway", foreground="gray")
        elif rem <= 0:
            self.timer_label.config(text="Expired", foreground="red")
        else:
            mins, secs = divmod(int(rem + 0.999), 60)
            color = "#c46a00" if rem <= 60 else "#1f7a1f"
            self.timer_label.config(text=f"{mins}:{secs:02d}", foreground=color)

    def sort_key(self):
        # Active timers first (sorted by remaining asc), then expired, then never-pinned.
        rem = self.remaining()
        if rem is None:
            return (2, 0.0)
        if rem <= 0:
            return (1, rem)  # most-recently expired closer to top of expired group
        return (0, rem)

    def destroy(self):
        self.frame.destroy()


class TrackerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Whatnot Giveaway Tracker")
        self.root.geometry("620x520")

        self.rows: list[StreamerRow] = []
        self.auto_add = tk.BooleanVar(value=True)

        top = ttk.Frame(root, padding=(10, 10, 10, 6))
        top.pack(fill="x")
        top.columnconfigure(1, weight=1)

        ttk.Label(top, text="Streamer:").grid(row=0, column=0, sticky="w")
        self.name_var = tk.StringVar()
        self.name_entry = ttk.Entry(top, textvariable=self.name_var)
        self.name_entry.grid(row=0, column=1, sticky="ew", padx=(6, 6))
        self.name_entry.bind("<Return>", lambda _e: self.add_streamer())
        ttk.Button(top, text="Add", command=self.add_streamer).grid(row=0, column=2)

        opts = ttk.Frame(root, padding=(10, 0, 10, 6))
        opts.pack(fill="x")
        ttk.Checkbutton(
            opts,
            text="Auto-add streamers when extension reports a pin",
            variable=self.auto_add,
        ).pack(side="left")
        self.status_label = ttk.Label(opts, text=f"Listening on {SERVER_HOST}:{SERVER_PORT}", foreground="gray")
        self.status_label.pack(side="right")

        ttk.Separator(root, orient="horizontal").pack(fill="x", padx=10)

        self.list_frame = ttk.Frame(root, padding=(10, 6))
        self.list_frame.pack(fill="both", expand=True)
        self.list_frame.columnconfigure(0, weight=1)

        self._tick()

    # ----- streamer list management -----

    def _find(self, name):
        for r in self.rows:
            if r.name.lower() == name.lower():
                return r
        return None

    def add_streamer(self):
        name = self.name_var.get().strip()
        if not name:
            return
        if self._find(name):
            messagebox.showinfo("Already tracking", f"{name} is already on the list.")
            return
        self._create_row(name)
        self.name_var.set("")
        self._relayout()

    def _create_row(self, name):
        row = StreamerRow(self.list_frame, name, self._on_pin, self._on_remove)
        self.rows.append(row)
        return row

    def _on_pin(self, row):
        row.start_timer()
        self._relayout()

    def _on_remove(self, row):
        self.rows.remove(row)
        row.destroy()
        self._relayout()

    # ----- event handling -----

    def _drain_events(self):
        while True:
            try:
                ev = _events.get_nowait()
            except queue.Empty:
                return
            if ev["type"] != "pin":
                continue
            name = ev["name"]
            fp = ev.get("fingerprint", "")
            row = self._find(name)
            if row is None:
                if not self.auto_add.get():
                    continue
                row = self._create_row(name)
            # Ignore duplicate fingerprints (same giveaway reported repeatedly).
            if fp and fp == row.last_fingerprint:
                continue
            row.last_fingerprint = fp
            row.start_timer()

    # ----- main loop -----

    def _relayout(self):
        self.rows.sort(key=lambda r: r.sort_key())
        for i, row in enumerate(self.rows):
            row.frame.grid(row=i, column=0, sticky="ew", pady=2)

    def _tick(self):
        self._drain_events()
        for row in self.rows:
            row.refresh()
        self._relayout()
        self.root.after(TICK_MS, self._tick)


def main():
    root = tk.Tk()
    app = TrackerApp(root)
    _start_server(lambda: [r.name for r in app.rows])
    root.mainloop()


if __name__ == "__main__":
    main()
