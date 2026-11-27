# Changelog
## 1.3.0
- Multi-root workspaces: every folder gets its own SnapTrack in Source Control (changes, commit box, Start Tracking button), badges and gutter bars.
- SnapTrack History shows one group per tracked folder. File History, the line hover and Revert Change follow the folder of the open file.
- Commands from the Command Palette use the open file's folder, or ask which folder.
- The status bar shows the folder of the open file. Folders added to or removed from the workspace are picked up right away.
## 1.2.0
- Revert Change at Cursor: put back just the changed block under the cursor (right-click in the editor). Ctrl+Z undoes it.
- Line history hover: hover a line to see which commit or checkpoint last changed it (snaptrack.lineHistoryHover).
- Recently deleted: files from your history that are gone from disk show at the top of SnapTrack History, ready to restore.
- Save Checkpoint As…: named checkpoints with a tag icon. They are pinned automatically.
- Pin / Unpin any commit or checkpoint so Clean Up never removes it.
- Search History by message, file name or date.
- Line stats (+added −deleted) on every commit and file in SnapTrack History.
- Status bar shows the change count, time since the last checkpoint, and storage size in the tooltip.
- Suggested commit message (e.g. "Update index.php (+1 new)") when the message box is empty.
- Convert History to a Git Repository: turns your commits into a real Git repo in a new folder (needs Git installed). Your project folder is not changed.
- Auto cleanup: snaptrack.autoCleanup.checkpointMaxAgeDays and snaptrack.autoCleanup.maxCheckpoints (both off by default).
- Fix: a file rewritten with the same size within the same instant could be missed as a change. Recently modified files are now always re-read.
- Brighter M / A / D colors so changes stand out in Source Control, the Explorer and History.
- New README with a demo GIF, quick start, FAQ and settings table.
## 1.1.1
- M / A / D letters now show in the Changes list (like Git) and are colored even when the Git extension is off.
- Shorter dates in SnapTrack History.
## 1.1.0
- SnapTrack History sidebar (in Source Control): every commit and checkpoint, expand to see changed files, click for the diff. Compare with current files, Select for Compare / Compare with Selected, or Compare Two Commits.
- SnapTrack File History: versions of the file open in the editor; click to compare, or restore.
- Auto checkpoints every 10 minutes (snaptrack.autoCheckpointMinutes, 0 = off), optional checkpoint on save, and Save Checkpoint Now. Checkpoints never change your Changes list.
- Restore Project to a commit (whole folder), Undo Last Commit (files stay, changes come back).
- Safety net: a checkpoint is saved automatically before Discard, Discard All, Restore Project and Restore Version.
- Export changes or a commit as a .patch, or a commit as a .zip.
- Clean Up Storage: delete checkpoints, old commits, unused data.
- CLI: checkpoint, compare, restore-all, undo, export patch|zip, prune.
## 1.0.1
- Easier to start: a + (Start Tracking) button in the SnapTrack Source Control panel, a "SnapTrack: Start" status bar button, and a one-time "Track this folder?" prompt. (The welcome link was hidden when another provider such as Git was active.)
- New "SnapTrack: Show Log" output for troubleshooting.
## 1.0.0
- First release: snapshots, Source Control view with M / A / D, Git-style diffs, gutter markers, commit with confirmation, commit one file, discard, commit history, file history and restore, CLI.
