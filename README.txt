AIRGAP — stable playback/AI ordering fix

This build fixes a request-order bug where the AI result list was rendered AFTER playback started.
The chosen track index therefore pointed into the previous request's Spotify result list, causing:
Bahubali -> Korean -> relaxing to play one request behind.

It now:
- plays the exact chosen track object returned by the current AI request
- renders the current result list before playback
- ignores stale AI responses if a newer request was submitted
- keeps Spotify/local playback controls from racing

Run:
python app.py
Then open http://127.0.0.1:8000
