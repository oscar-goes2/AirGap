import os, json, time, secrets, hashlib, base64, urllib.parse, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"

SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "").strip()
SPOTIFY_REDIRECT_URI = os.environ.get("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8000/callback").strip()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "").strip()

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_URL = "https://api.spotify.com/v1"

# Spotify Web Playback + player-control scopes.
SCOPES = "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-read-currently-playing"

oauth_state = None
pkce_verifier = None
token_data = {}
last_plan = None
last_tracks = []
conversation = []

def json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")

def send_json(handler, obj, status=200):
    body = json_bytes(obj)
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)

def form_post(url, data):
    encoded = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=encoded, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def http_json(url, headers=None, method="GET", body=None):
    data = None
    hdrs = headers or {}
    if body is not None:
        data = json.dumps(body).encode()
        hdrs = {**hdrs, "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {detail[:500]}")

def pkce_challenge(verifier):
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()

def access_token():
    if not token_data:
        return None
    if token_data.get("expires_at", 0) > time.time() + 45:
        return token_data.get("access_token")
    refresh = token_data.get("refresh_token")
    if not refresh or not SPOTIFY_CLIENT_ID:
        return None
    refreshed = form_post(TOKEN_URL, {
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": SPOTIFY_CLIENT_ID,
    })
    token_data.update(refreshed)
    token_data["expires_at"] = time.time() + int(refreshed.get("expires_in", 3600))
    return token_data.get("access_token")

def spotify_api(path, params=None, method="GET", body=None):
    token = access_token()
    if not token:
        raise RuntimeError("Spotify is not connected.")
    url = API_URL + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"Authorization": "Bearer " + token}
    return http_json(url, headers=headers, method=method, body=body)

def normalize_track(t):
    artists = t.get("artists") or []
    album = t.get("album") or {}
    return {
        "id": t.get("id"),
        "uri": t.get("uri"),
        "name": t.get("name"),
        "artists": ", ".join(a.get("name","") for a in artists),
        "album": album.get("name", ""),
        "image": ((album.get("images") or [{}])[0].get("url")),
        "duration_ms": t.get("duration_ms"),
        "url": (t.get("external_urls") or {}).get("spotify"),
    }

def spotify_search(q, limit=10):
    data = spotify_api("/search", {"q": q, "type": "track", "limit": min(limit, 50)})
    return [normalize_track(t) for t in (data.get("tracks") or {}).get("items", [])]

def ollama_models():
    try:
        data = http_json(OLLAMA_URL + "/api/tags")
        return [m.get("name") for m in data.get("models", []) if m.get("name")]
    except Exception:
        return []

def choose_ollama_model():
    if OLLAMA_MODEL:
        return OLLAMA_MODEL
    models = ollama_models()
    if not models:
        return None
    # Prefer larger/common reasoning-capable local models when present.
    preferred = ["qwen3:8b", "qwen3:4b", "qwen2.5:7b", "qwen2.5:3b", "llama3.1:8b", "llama3.2:3b"]
    for p in preferred:
        if p in models:
            return p
    return models[0]

def _ollama_chat(messages, temperature=0.35):
    model = choose_ollama_model()
    if not model: raise RuntimeError("Ollama is not running or has no model installed.")
    data = http_json(OLLAMA_URL + "/api/chat", {"model":model,"messages":messages,"stream":False,"format":"json","options":{"temperature":temperature,"num_ctx":4096}})
    return json.loads(((data.get("message") or {}).get("content") or "{}").strip())

def ai_plan(user_text, context=None):
    context=context or {}
    system="""You are AIRGAP, a conversational AI music assistant. Understand what the human MEANS, not their literal words. Use your own knowledge of music, artists, films, soundtracks, languages, genres, moods and culture. Understand English, Hinglish, slang, vague requests and follow-ups. 'play something funky' means discover funky/groovy music, not a song titled funky and not generic popular music. 'play something phonk' means phonk discovery. 'arijit ka gaana chalao' means Arijit Singh. 'songs from bahubali' means its film soundtrack. 'something like this but darker' uses the current track as context. 'another one' or 'different' continues the current intent while avoiding current/recent tracks. 'shuffle my playlist' means shuffle the current queue only and never search for new songs. Never invent Spotify IDs, URLs or availability. Actual tracks must come from Spotify or the local library. Return ONLY JSON with keys reply, action, request_type, source, understanding, artist, title, album, context, language, genres, moods, activities, search_queries, exclude_terms, needs_clarification. action is play/search/pause/resume/stop/next/previous/shuffle/queue/none. request_type is exact_track/artist/album/soundtrack/discovery/playlist/control/conversation. source is local/spotify/either/none. For discovery create 2-6 semantic searches, never copy the request literally. Never use popular unless explicitly requested."""
    messages=[{"role":"system","content":system}]+conversation[-12:]+[{"role":"system","content":"APPLICATION STATE:\n"+json.dumps(context,ensure_ascii=False)[:9000]},{"role":"user","content":user_text}]
    try:return _ollama_chat(messages,.45),None
    except Exception as e:return fallback_plan(user_text),str(e)

def ai_rank(user_text,candidates,context=None):
    if not candidates:return [],None
    system="""You are AIRGAP's music selection judge. Rank REAL Spotify candidates by semantic fit to the human request. Do not choose a track just because a word appears in its title. Do not favor popularity unless requested. Respect artist, soundtrack, language, genre, mood and context. For 'different' or 'another', avoid current/recent tracks. Return ONLY JSON {\"order\":[0,1,2],\"reason\":\"brief reason\"}."""
    payload={"request":user_text,"context":context or {},"candidates":[{"i":i,"name":t.get("name"),"artists":t.get("artists"),"album":t.get("album")} for i,t in enumerate(candidates[:30])]}
    try:
        obj=_ollama_chat([{"role":"system","content":system},{"role":"user","content":json.dumps(payload,ensure_ascii=False)}],.15)
        order=[int(x) for x in obj.get("order",[]) if str(x).isdigit() and 0<=int(x)<len(candidates)]
        order += [i for i in range(min(30,len(candidates))) if i not in order]
        return order,obj.get("reason")
    except Exception as e:return list(range(min(5,len(candidates)))),str(e)

def ai_final_reply(user_text,plan,candidates,chosen=None,context=None):
    if not candidates and plan.get("action") in ("play","search","queue"):return "I understood you, but I couldn't find a good match. Give me one more detail about the sound you want."
    if plan.get("action") in ("pause","resume","stop","next","previous","shuffle"):return plan.get("reply") or "Done."
    system="""You are AIRGAP replying after a music action. Be natural, concise and conversational. Do not expose JSON or internal tools. Say what you understood and what you did. If a track was selected, name it and artist. Do not claim playback unless a selected track exists. Return JSON {\"reply\":\"...\"}."""
    payload={"request":user_text,"plan":plan,"selected":chosen,"candidates":candidates[:8],"context":context or {}}
    try:return _ollama_chat([{"role":"system","content":system},{"role":"user","content":json.dumps(payload,ensure_ascii=False)}],.55).get("reply") or plan.get("reply") or "Done."
    except Exception:return f"Got it — playing {chosen.get('name')} by {chosen.get('artists')}." if chosen else plan.get("reply") or "Got it."



def fallback_plan(text):
    s=text.lower().strip()
    plan={"reply":"I'll find a good match.","action":"play","request_type":"discovery","source":"spotify",
          "understanding":text,"artist":"","title":"","album":"","context":"","language":"",
          "genres":[],"moods":[],"activities":[],"search_queries":[],"exclude_terms":[],
          "needs_clarification":False}
    controls={"pause":"pause","resume":"resume","continue":"resume","stop":"stop","next":"next",
              "skip":"next","previous":"previous","back":"previous","shuffle":"shuffle"}
    for k,v in controls.items():
        if s==k or s.startswith(k+" ") or (v=="shuffle" and "shuffle" in s):
            plan["action"]=v; plan["request_type"]="control"
            plan["reply"]={"pause":"Pausing.","resume":"Resuming.","stop":"Stopping.",
                           "next":"Skipping ahead.","previous":"Going back.",
                           "shuffle":"Shuffling the current queue."}[v]
            return plan
    langs={"korean":"Korean","k-pop":"Korean","kpop":"Korean","chinese":"Chinese",
           "mandarin":"Chinese","c-pop":"Chinese","hindi":"Hindi","punjabi":"Punjabi",
           "tamil":"Tamil","telugu":"Telugu","japanese":"Japanese","j-pop":"Japanese",
           "spanish":"Spanish"}
    for k,v in langs.items():
        if k in s: plan["language"]=v; break
    moods={"funky":"funk","phonk":"phonk","relax":"relaxed","calm":"calm","chill":"chill",
           "sad":"sad","happy":"happy","romantic":"romantic","energetic":"energetic",
           "peaceful":"peaceful","dark":"dark"}
    for k,v in moods.items():
        if k in s: plan["moods"].append(v)
    acts={"study":"study","studying":"study","workout":"workout","gym":"workout",
          "party":"party","driving":"driving","drive":"driving"}
    for k,v in acts.items():
        if k in s: plan["activities"].append(v)
    if "arijit" in s:
        plan["artist"]="Arijit Singh"; plan["request_type"]="artist"
    if "bahubali" in s or "baahubali" in s:
        plan["context"]="Baahubali"; plan["request_type"]="soundtrack"
    if " by " in s:
        a=text.split(" by ",1)[1].strip(" .!?")
        if a: plan["artist"]=a; plan["request_type"]="artist"
    if s.startswith("play ") and not plan["artist"] and not plan["context"] and not plan["moods"] and not plan["language"] and not plan["activities"]:
        title=text[5:].strip(" .!?")
        if title and len(title.split())<=6:
            plan["title"]=title; plan["request_type"]="exact_track"
    base=[]
    if plan["language"]: base.append(plan["language"]+" music")
    base += plan["moods"] + plan["activities"]
    if plan["artist"]: base += [plan["artist"]+" songs","artist:"+plan["artist"]]
    if plan["context"]: base += [plan["context"]+" soundtrack",plan["context"]+" movie songs"]
    if plan["title"]: base += [plan["title"]]
    if not base: base=[text]
    plan["search_queries"]=base[:6]
    return plan

def score_track(t, plan):
    text=(t.get("name","")+" "+t.get("artists","")+" "+t.get("album","")).lower()
    score=0
    for x in plan.get("exclude_terms",[])+plan.get("exclude_words",[]):
        if x and x.lower() in text: score-=100
    if plan.get("artist") and plan["artist"].lower() in t.get("artists","").lower(): score+=100
    if plan.get("title") and plan["title"].lower() in t.get("name","").lower(): score+=150
    if plan.get("album") and plan["album"].lower() in t.get("album","").lower(): score+=100
    if plan.get("context") and plan["context"].lower() in text: score+=80
    for x in plan.get("genres",[])+plan.get("moods",[])+plan.get("activities",[]):
        if x and x.lower() in text: score+=10
    return score

def search_from_plan(plan):
    global last_tracks
    queries=plan.get("search_queries") or []
    rt=plan.get("request_type")
    if rt=="artist" and plan.get("artist"):
        queries=[f'artist:"{plan["artist"]}"',f'{plan["artist"]} songs',f'{plan["artist"]} top tracks']
    elif rt=="exact_track" and plan.get("title"):
        queries=[f'{plan.get("title","")} {plan.get("artist","")}'.strip()]
    elif rt in ("soundtrack","album") and (plan.get("context") or plan.get("album")):
        x=plan.get("context") or plan.get("album")
        queries=[f'{x} soundtrack',f'{x} songs',f'{x} original soundtrack']
    all_tracks=[]; seen=set()
    for q in queries[:8]:
        try:
            for t in spotify_search(q,10):
                if t.get("id") and t["id"] not in seen:
                    seen.add(t["id"]); all_tracks.append(t)
        except Exception:
            pass
    all_tracks.sort(key=lambda t:score_track(t,plan),reverse=True)
    last_tracks=all_tracks[:30]
    return last_tracks

def choose_agent_track(user_text, plan, tracks, context=None):
    if not tracks: return None, None
    order, reason=ai_rank(user_text,tracks,context or {})
    if not order: order=list(range(len(tracks)))
    i=max(0,min(order[0],len(tracks)-1))
    return tracks[i], reason

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt, *args):
        print(fmt % args)

    def do_GET(self):
        global oauth_state, pkce_verifier, token_data

        u = urllib.parse.urlparse(self.path)
        p = u.path

        if p == "/spotify/login":
            if not SPOTIFY_CLIENT_ID:
                return send_json(self, {"error":"SPOTIFY_CLIENT_ID is not set."}, 500)
            oauth_state = secrets.token_urlsafe(24)
            pkce_verifier = secrets.token_urlsafe(64)
            challenge = pkce_challenge(pkce_verifier)
            params = {
                "client_id": SPOTIFY_CLIENT_ID,
                "response_type": "code",
                "redirect_uri": SPOTIFY_REDIRECT_URI,
                "scope": SCOPES,
                "state": oauth_state,
                "code_challenge_method": "S256",
                "code_challenge": challenge,
            }
            self.send_response(302)
            self.send_header("Location", AUTH_URL + "?" + urllib.parse.urlencode(params))
            self.end_headers()
            return

        if p == "/callback":
            qs = urllib.parse.parse_qs(u.query)
            code = qs.get("code", [None])[0]
            state = qs.get("state", [None])[0]
            error = qs.get("error", [None])[0]
            if error:
                self.send_response(302)
                self.send_header("Location", "/?error=" + urllib.parse.quote("Spotify authorization failed: " + error))
                self.end_headers()
                return
            if not code or not state or state != oauth_state or not pkce_verifier:
                return send_json(self, {"error":"Invalid Spotify OAuth state/code. Start Connect again."}, 400)
            try:
                refreshed = form_post(TOKEN_URL, {
                    "grant_type":"authorization_code",
                    "code":code,
                    "redirect_uri":SPOTIFY_REDIRECT_URI,
                    "client_id":SPOTIFY_CLIENT_ID,
                    "code_verifier":pkce_verifier
                })
                token_data = dict(refreshed)
                token_data["expires_at"] = time.time() + int(refreshed.get("expires_in", 3600))
                oauth_state = None
                pkce_verifier = None
                self.send_response(302)
                self.send_header("Location", "/?spotify=connected")
                self.end_headers()
            except Exception as e:
                return send_json(self, {"error":"Spotify token exchange failed: " + str(e)}, 500)
            return

        if p == "/api/status":
            tok = access_token()
            return send_json(self, {
                "spotify_connected": bool(tok),
                "client_configured": bool(SPOTIFY_CLIENT_ID),
                "ollama_model": choose_ollama_model(),
                "ollama_available": bool(ollama_models()),
                "redirect_uri": SPOTIFY_REDIRECT_URI
            })

        if p == "/api/spotify/status":
            return send_json(self, {
                "connected": bool(access_token()),
                "client_configured": bool(SPOTIFY_CLIENT_ID),
                "premium_required": True,
                "redirect_uri": SPOTIFY_REDIRECT_URI
            })

        if p == "/api/spotify/token":
            tok = access_token()
            if not tok:
                return send_json(self, {"error":"Spotify not connected"}, 401)
            return send_json(self, {"access_token":tok})

        if p == "/api/spotify/search":
            q = urllib.parse.parse_qs(u.query).get("q", [""])[0].strip()
            if not q:
                return send_json(self, {"tracks":[]})
            try:
                return send_json(self, {"tracks":spotify_search(q, 20)})
            except Exception as e:
                return send_json(self, {"tracks":[], "error":str(e)}, 200)

        if p == "/api/spotify/player":
            try:
                return send_json(self, spotify_api("/me/player"))
            except Exception as e:
                return send_json(self, {"error":str(e)}, 500)

        if p == "/api/ai":
            q = urllib.parse.parse_qs(u.query).get("q", [""])[0].strip()
            if not q:
                return send_json(self, {"error":"Empty request"}, 400)
            context_raw = urllib.parse.parse_qs(u.query).get("context", ["{}"])[0]
            try:
                context = json.loads(context_raw)
            except Exception:
                context = {}

            # Never allow an Ollama/Spotify exception to become ERR_EMPTY_RESPONSE.
            try:
                plan, ai_error = ai_plan(q, context)
                if not isinstance(plan, dict):
                    plan = fallback_plan(q)

                action = plan.get("action", "play")
                tracks = []
                chosen = None
                rank_reason = None

                if action in ("play", "search", "queue"):
                    try:
                        tracks = search_from_plan(plan)
                    except Exception as e:
                        ai_error = (ai_error + " | " if ai_error else "") + "Spotify search: " + str(e)
                        tracks = []

                    if tracks:
                        chosen, rank_reason = choose_agent_track(q, plan, tracks, context)
                        if chosen and action == "play":
                            plan["reply"] = f"Found {chosen.get('name')} by {chosen.get('artists')}."
                    else:
                        plan["reply"] = plan.get("reply") or "I understood the request, but found no matching tracks."

                conversation.append({"role":"user","content":q})
                conversation.append({"role":"assistant","content":json.dumps(plan,ensure_ascii=False)})

                return send_json(self, {
                    "request":q,
                    "plan":plan,
                    "tracks":tracks[:20],
                    "chosen":chosen,
                    "rank_reason":rank_reason,
                    "ai_error":ai_error
                })
            except Exception as e:
                return send_json(self, {
                    "request":q,
                    "plan":fallback_plan(q),
                    "tracks":[],
                    "chosen":None,
                    "ai_error":"AI endpoint recovered from: "+str(e)
                }, 200)

        if p == "/api/ai/rank":
            return send_json(self,{"error":"Use POST"},405)

        # Let SimpleHTTPRequestHandler serve the UI.
        return super().do_GET()

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length","0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            body = {}

        if p == "/api/ai/rank":
            try:
                order,reason=ai_rank(body.get("request", ""),body.get("candidates",[]),body.get("context",{}))
                return send_json(self,{"order":order,"reason":reason})
            except Exception as e:
                return send_json(self,{"error":str(e)},500)

        if p == "/api/spotify/transfer":
            try:
                device_id = body.get("device_id")
                if not device_id:
                    return send_json(self, {"error":"No browser player device ID."}, 400)
                spotify_api("/me/player", method="PUT", body={"device_ids":[device_id], "play":False})
                return send_json(self, {"ok":True})
            except Exception as e:
                return send_json(self, {"error":str(e)}, 500)

        if p == "/api/spotify/play":
            try:
                uri = body.get("uri")
                device_id = body.get("device_id")
                if not uri:
                    return send_json(self, {"error":"No Spotify track URI."}, 400)
                if not device_id:
                    return send_json(self, {"error":"Browser Spotify player is not ready yet."}, 400)

                # Always transfer immediately before playing. Spotify does not guarantee
                # ordering between transfer and other Player API calls, so wait until the
                # browser device is actually visible/active before sending the play call.
                spotify_api("/me/player", method="PUT", body={"device_ids":[device_id], "play":False})

                active = False
                for _ in range(12):
                    time.sleep(0.35)
                    try:
                        devices = spotify_api("/me/player/devices").get("devices", [])
                        active = any(d.get("id") == device_id and d.get("is_active") for d in devices)
                        if active:
                            break
                    except Exception:
                        pass

                if not active:
                    return send_json(self, {
                        "error":"Spotify saw the browser player, but did not make it active. Click PLAY once and try again."
                    }, 503)

                spotify_api("/me/player/play", params={"device_id":device_id}, method="PUT", body={"uris":[uri]})
                return send_json(self, {"ok":True, "device_id":device_id, "uri":uri})
            except Exception as e:
                return send_json(self, {"error":str(e)}, 500)

        if p == "/api/spotify/control":
            try:
                action = body.get("action")
                device_id = body.get("device_id")
                path = {
                    "pause":"/me/player/pause",
                    "next":"/me/player/next",
                    "previous":"/me/player/previous",
                    "resume":"/me/player/play"
                }.get(action)
                if not path:
                    return send_json(self, {"error":"Unknown control"}, 400)
                params = {"device_id":device_id} if device_id else None
                spotify_api(path, params=params, method="PUT" if action in ("pause","resume") else "POST")
                return send_json(self, {"ok":True})
            except Exception as e:
                return send_json(self, {"error":str(e)}, 500)

        return send_json(self, {"error":"Not found"}, 404)

if __name__ == "__main__":
    print("AI Voice-Enabled MP3 Player V19 FINAL — WORKING BUILD")
    print("Open: http://127.0.0.1:8000")
    print("Spotify client configured:", bool(SPOTIFY_CLIENT_ID))
    print("Ollama model:", choose_ollama_model() or "NONE (fallback mode)")
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", 8000))), Handler).serve_forever()