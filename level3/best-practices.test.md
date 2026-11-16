# General text editor best practices

You can't be a good vim-like text editor without being a good text editor
in-general.

## `atomic-writes` Files are saved atomically

There may be tools watching files for changes, eg a dev server that
hot-reloads modules or a language server that maintains an index of
definitions and usages. Outside of uncommon special cases, saving changes
to a file should work by creating a new file, and renaming it into place,
so that these tools never see a half-written file.

## `watch-for-changes` Watch for changes to a file being edited

If a user is editing a file, and the file is modified externally, it would be a
bad thing if they weren't notified, continued editing, and unknowingly reverted
the external changes the next time they saved. The minimal solution to this is
to check, on save, that the file is still the same as it was when it was opened
(based on mtime). A better solution is to have a filesystem watcher, and notify
the user when the file changes. Don't refresh in a way that loses the unsaved
changes, though.

## `autosave-or-swap` Save something while running in case of a crash

In vim, there is a "swap file" which records edits to a file as they're made,
so that if the editor crashes, the computer is turned off, etc, they can be
recovered.

## `backup-files-or-undo` Save a backup file or undo entry

When you overwrite a file, it should either retain an undo history somewhere,
or save a backup file somewhere. (But preferrably not a file~ file in the same
directory, at least by default; users find those annoying.)

## `crlf-handling` Handle CRLF, LF and mixed files

If a file has consistent line endings (LF, or CRLF), editing and saving it
should, by default, save the file with the same type of line endings.

