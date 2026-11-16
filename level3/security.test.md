# Security

## `configs-untrusted` Config files and modelines

When opening a project in an IDE, it is unavoidably trusted, because the user
is probably going to compile the project with the provided build scripts and
run it. However, text editors are sometimes used to open untrusted files, or
files in untrusted directories, and that needs to be handled securely. If there
is a modeline feature, or if files like .editorconfig or a project file are
opened automatically, these may be untrusted.

## `escape-sequences-untrusted` Escape sequences 

In an editor that runs in a terminal, opening a file that contains xterm-style
escape sequences should not send those escape sequences to the terminal.

## `no-large-hidden-blobs` No hidden blobs

There should not be a way to put an arbitrarily-large payload into a text file
without either a correspondingly large visual footprint, or a warning on open.
Supply-chain attacks in the past have worked by adding lines to compromised
maintainers' source files which contain a small unpacker, combined with a long
string of zero-width unicode characters; the idea is that this reduces the
probability that, when someone views the compromised file, they'll notice that
there's something wrong. This can be mitigated with a warning or highlight when
the ratio between a line's rendered text width and its length in bytes is far
from the expected range.

