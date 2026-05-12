"""Whatnot giveaway timer tracker.

A small Tkinter GUI for tracking active giveaways across streamers.
Add a streamer to the list, then hit "Pin Giveaway" each time the streamer
pins a new giveaway -- the row jumps to the bottom and a fresh 5:00 countdown
begins. Expired timers stay on the list (marked "Expired") until you remove
the streamer or pin the next giveaway.
"""

import time
import tkinter as tk
from tkinter import ttk, messagebox

GIVEAWAY_SECONDS = 5 * 60
TICK_MS = 250


class StreamerRow:
    def __init__(self, parent, name, on_pin, on_remove):
        self.name = name
        self.deadline = None  # epoch seconds; None means no active timer

        self.frame = ttk.Frame(parent, padding=(8, 4))
        self.frame.columnconfigure(0, weight=1)

        self.name_label = ttk.Label(self.frame, text=name, font=("TkDefaultFont", 11, "bold"))
        self.name_label.grid(row=0, column=0, sticky="w")

        self.timer_label = ttk.Label(self.frame, text="No active giveaway", width=20, anchor="e")
        self.timer_label.grid(row=0, column=1, padx=(8, 8))

        self.pin_btn = ttk.Button(self.frame, text="Pin Giveaway", command=lambda: on_pin(self))
        self.pin_btn.grid(row=0, column=2, padx=(0, 4))

        self.remove_btn = ttk.Button(self.frame, text="Remove", command=lambda: on_remove(self))
        self.remove_btn.grid(row=0, column=3)

    def start_timer(self):
        self.deadline = time.monotonic() + GIVEAWAY_SECONDS

    def refresh(self):
        if self.deadline is None:
            self.timer_label.config(text="No active giveaway", foreground="gray")
            return
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            self.timer_label.config(text="Expired", foreground="red")
        else:
            mins, secs = divmod(int(remaining + 0.999), 60)
            color = "darkorange" if remaining <= 60 else "darkgreen"
            self.timer_label.config(text=f"{mins}:{secs:02d}", foreground=color)

    def destroy(self):
        self.frame.destroy()


class TrackerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Whatnot Giveaway Tracker")
        self.root.geometry("560x480")

        self.rows = []  # display order: top -> bottom

        top = ttk.Frame(root, padding=(10, 10, 10, 6))
        top.pack(fill="x")
        top.columnconfigure(1, weight=1)

        ttk.Label(top, text="Streamer:").grid(row=0, column=0, sticky="w")
        self.name_var = tk.StringVar()
        self.name_entry = ttk.Entry(top, textvariable=self.name_var)
        self.name_entry.grid(row=0, column=1, sticky="ew", padx=(6, 6))
        self.name_entry.bind("<Return>", lambda _e: self.add_streamer())

        ttk.Button(top, text="Add", command=self.add_streamer).grid(row=0, column=2)

        ttk.Separator(root, orient="horizontal").pack(fill="x", padx=10)

        self.list_frame = ttk.Frame(root, padding=(10, 6))
        self.list_frame.pack(fill="both", expand=True)
        self.list_frame.columnconfigure(0, weight=1)

        self._tick()

    def add_streamer(self):
        name = self.name_var.get().strip()
        if not name:
            return
        if any(r.name.lower() == name.lower() for r in self.rows):
            messagebox.showinfo("Already tracking", f"{name} is already on the list.")
            return
        row = StreamerRow(self.list_frame, name, self._on_pin, self._on_remove)
        self.rows.append(row)
        self._relayout()
        self.name_var.set("")

    def _on_pin(self, row):
        row.start_timer()
        # Move to bottom of the list.
        self.rows.remove(row)
        self.rows.append(row)
        self._relayout()

    def _on_remove(self, row):
        self.rows.remove(row)
        row.destroy()
        self._relayout()

    def _relayout(self):
        for i, row in enumerate(self.rows):
            row.frame.grid(row=i, column=0, sticky="ew", pady=2)

    def _tick(self):
        for row in self.rows:
            row.refresh()
        self.root.after(TICK_MS, self._tick)


def main():
    root = tk.Tk()
    TrackerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
