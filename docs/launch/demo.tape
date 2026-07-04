# Urfael hero GIF — the security benchmark resisting the attacks that owned the others.
# Record with:  vhs docs/launch/demo.tape    (run from the repo root; needs `npm i` in app/)
# Output:       docs/media/demo.gif
# The clip is the real `npm run security` — read-only, deterministic, no personal data.

Output docs/media/demo.gif

Set Shell "zsh"
Set FontSize 15
Set Width 1320
Set Height 860
Set Padding 20
Set TypingSpeed 55ms
Set Framerate 24
Set PlaybackSpeed 1.0

# Set up the shell off-camera: enter app/, strip the ELECTRON_RUN_AS_NODE shell quirk, clear.
Hide
Type "cd app 2>/dev/null || cd ~/urfael-src/app" Enter
Type "unset ELECTRON_RUN_AS_NODE" Enter
Type "clear" Enter
Sleep 600ms
Show

# The money shot: run the benchmark, let the ✓ RESISTED lines scroll, land on 11/11 attack classes, 116/116 checks.
Type "npm run security" Sleep 500ms Enter
Sleep 5s

# Hold on the final banner.
Sleep 2500ms
