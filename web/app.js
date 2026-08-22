const $ = id => document.getElementById(id);
let spotifyPlayer = null, deviceId = null, connected = false, playerInitStarted = false, playbackActivated = false;
let spotifyTracks = [], spotifyIndex = -1;
let localTracks = [], queue = [], queueIndex = -1, queueMode = "local", shuffleMode = false, repeatMode = false;
let recognition = null, voiceMode = false, commandMode = false;
let spotifyPlayInFlight = false, spotifyActionInFlight = false, playbackGeneration = 0, aiRequestGeneration = 0, scrubbingGlobal = false;
let localAudio = new Audio();
localAudio.preload = "metadata";
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function setText(id,value){const el=$(id);if(el)el.textContent=value;}
function showError(msg){const el=$("error");if(!el)return;if(!msg){el.textContent="";el.style.display="none";return;}el.textContent=msg;el.style.display="block";}
async function api(url,opts={}){const r=await fetch(url,opts);const d=await r.json().catch(()=>({error:`HTTP ${r.status}`}));if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d;}
function log(msg){const d=new Date(),ts=d.toTimeString().slice(0,8);const el=$("terminal");if(!el)return;el.insertAdjacentHTML("beforeend",`<div><span class="text-orange-500">${ts}</span> ${esc(msg)}</div>`);el.scrollTop=el.scrollHeight;}

function setState(title,sub,badge="IDLE"){setText("stateBadge",badge);setText("transcript",`> ${sub}`);}

function formatTime(sec){if(!Number.isFinite(sec))return "00:00";sec=Math.max(0,Math.floor(sec));return `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;}
function currentTrack(){return queueMode==="local" ? queue[queueIndex] : spotifyTracks[spotifyIndex];}
function currentList(){return queueMode==="local" ? queue : spotifyTracks;}

function renderLibrary(){
  const el=$("library");
  if(!localTracks.length){el.innerHTML=`<div class="p-8 text-center text-zinc-600 mono text-[10px]">NO LOCAL AUDIO INDEXED<br><span class="text-zinc-500">Use ADD FOLDER to choose a music folder.</span></div>`;$("fileCount").textContent="00 FILES";return;}
  el.innerHTML=localTracks.map((t,i)=>`<div class="library-row ${queueMode==="local"&&queueIndex===i?'active':''} px-4 py-3 flex items-center gap-3" data-i="${i}">
    <button class="local-play w-8 h-8 rounded-lg tactile flex items-center justify-center" title="Play"><i data-lucide="${queueMode==="local"&&queueIndex===i&& !localAudio.paused?'pause':'play'}" class="w-3.5 h-3.5"></i></button>
    <span class="mono text-[9px] text-zinc-600 w-5">${String(i+1).padStart(2,"0")}</span>
    <span class="min-w-0 flex-1"><span class="block text-sm truncate">${esc(t.title)}</span><span class="block text-[10px] text-zinc-500 truncate">${esc(t.artist||t.folder||"Local file")}</span></span>
    <span class="chip px-1.5 py-1 rounded mono text-[8px]">LOCAL</span>
    <button class="queue-add tactile px-2 py-1 rounded mono text-[8px]" title="Add to queue">+Q</button>
  </div>`).join("");
  el.querySelectorAll(".library-row").forEach(row=>{const i=+row.dataset.i;row.querySelector(".local-play").onclick=()=>playLocal(i);row.querySelector(".queue-add").onclick=e=>{e.stopPropagation();addToQueue(localTracks[i]);};});
  $("fileCount").textContent=`${String(localTracks.length).padStart(2,"0")} FILES / LOCAL`;
  lucide.createIcons();
}

function addToQueue(track){if(!queue.some(x=>x.key===track.key)){queue.push(track);log(`queue + ${track.title}`);}renderQueue();}
function renderQueue(){
  const el=$("queue");if(!el)return;
  if(!queue.length){el.innerHTML=`<div class="p-5 text-center text-zinc-600 mono text-[9px]">QUEUE EMPTY</div>`;$("queueCount").textContent="00";return;}
  el.innerHTML=queue.map((t,i)=>`<div class="library-row ${queueIndex===i?'active':''} px-3 py-2 flex items-center gap-2"><span class="mono text-[9px] text-zinc-600 w-4">${i+1}</span><button class="queue-play flex-1 min-w-0 text-left"><span class="block text-xs truncate">${esc(t.title)}</span><span class="block text-[9px] text-zinc-600 truncate">${esc(t.artist||"Local")}</span></button><button class="queue-remove mono text-[9px] text-zinc-600 hover:text-orange-400" data-i="${i}">×</button></div>`).join("");
  el.querySelectorAll(".queue-play").forEach((b,i)=>b.onclick=()=>playQueueIndex(i));el.querySelectorAll(".queue-remove").forEach(b=>b.onclick=()=>{const i=+b.dataset.i;queue.splice(i,1);if(queueIndex>=queue.length)queueIndex=queue.length-1;renderQueue();});$("queueCount").textContent=String(queue.length).padStart(2,"0");
}

function parseFile(file){
  const rel=file.webkitRelativePath||file.name;const parts=rel.split("/");let title=file.name.replace(/\.[^.]+$/i,"");let artist="";
  // Friendly parsing: Artist - Title.mp3. Otherwise keep filename intact.
  const m=title.match(/^(.+?)\s+-\s+(.+)$/);if(m){artist=m[1].trim();title=m[2].trim();}
  return {key:rel+"|"+file.size,title,artist,folder:parts.length>1?parts[parts.length-2]:"",file,url:URL.createObjectURL(file),duration:0,type:"local"};
}
async function stopSpotifyPlayback(){
  // Do NOT call spotifyPlayer.pause() here. The Web Playback SDK can reject an
  // in-flight play() with AbortError when pause() races it. The backend control
  // endpoint is enough to stop Spotify and is safe even when no device is active.
  if(!deviceId)return;
  try{
    await api("/api/spotify/control",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"pause",device_id:deviceId})
    });
  }catch(e){}
}


async function addFolder(files){
  const accepted=[...files].filter(f=>/\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(f.name));
  const seen=new Set(localTracks.map(x=>x.key));let added=0;
  for(const f of accepted){const t=parseFile(f);if(!seen.has(t.key)){localTracks.push(t);seen.add(t.key);added++;}}
  localTracks.sort((a,b)=>a.title.localeCompare(b.title,undefined,{numeric:true,sensitivity:"base"}));
  // A local library is a hard playback-source switch: never leave Spotify playing underneath it.
  queue=[...localTracks];queueIndex=-1;queueMode="local";
  await stopSpotifyPlayback();
  spotifyIndex=-1;
  $("playingTag").textContent="LOCAL";
  $("playingTag").className="px-2 py-1 rounded border border-orange-500/20 bg-orange-500/5 text-orange-400";
  setState("LIBRARY READY",`${localTracks.length} local tracks indexed`,`LOCAL / ${localTracks.length}`);
  renderLibrary();renderQueue();
  log(`folder added — ${added} audio files; Spotify playback stopped`);
}

function playLocal(i){queueMode="local";queue=queue.length?queue:[...localTracks];const target=localTracks[i];let qi=queue.findIndex(x=>x.key===target.key);if(qi<0){queue.push(target);qi=queue.length-1;}playQueueIndex(qi);}
async function playQueueIndex(i){
  if(!queue.length)return;
  queueIndex=Math.max(0,Math.min(i,queue.length-1));
  queueMode="local";
  const t=queue[queueIndex];
  await stopSpotifyPlayback();
  spotifyIndex=-1;
  localAudio.src=t.url;
  localAudio.currentTime=0;
  localAudio.play().then(()=>{updateNowLocal(t);log(`playing local: ${t.title}`);})
    .catch(e=>showError(`Local playback failed: ${e.message}`));
  renderQueue();renderLibrary();
}
function updateNowLocal(t){$("title").textContent=t.title;$("artist").textContent=t.artist||t.folder||"Local file";$("playingTag").textContent="LOCAL";$("playingTag").className="px-2 py-1 rounded border border-orange-500/20 bg-orange-500/5 text-orange-400";$("now").textContent=`${t.title} — ${t.artist||"Local file"}`;$("stateBadge").textContent="PLAYING";$("current").textContent=formatTime(localAudio.currentTime);$("total").textContent=formatTime(localAudio.duration);$("progress").style.width="0%";}
async function stopLocal(){
  playbackGeneration++;
  localAudio.pause();
  localAudio.currentTime=0;
  await stopSpotifyPlayback();
  $("stateBadge").textContent="STOPPED";
  $("playIcon").setAttribute("data-lucide","play");
  lucide.createIcons();
}
function nextLocal(){if(!queue.length)return;if(shuffleMode&&queue.length>1){let n;do{n=Math.floor(Math.random()*queue.length)}while(n===queueIndex);queueIndex=n;}else{queueIndex=(queueIndex+1)%queue.length;}playQueueIndex(queueIndex);}
function prevLocal(){if(!queue.length)return;queueIndex=(queueIndex-1+queue.length)%queue.length;playQueueIndex(queueIndex);}
function shuffleQueue(){if(queue.length<2)return log("shuffle needs at least 2 local tracks");shuffleMode=!shuffleMode;$("shuffle").classList.toggle("border-orange-500",shuffleMode);$("shuffleState").textContent=shuffleMode?"ON":"OFF";log(`local queue shuffle ${shuffleMode?"enabled":"disabled"}`);}

localAudio.addEventListener("loadedmetadata",()=>{if(queueMode==="local")$("total").textContent=formatTime(localAudio.duration);});
localAudio.addEventListener("timeupdate",()=>{if(queueMode!=="local")return;const p=localAudio.duration?(localAudio.currentTime/localAudio.duration)*100:0;$("progress").style.width=p+"%";$("current").textContent=formatTime(localAudio.currentTime);});
localAudio.addEventListener("play",()=>{if(queueMode==="local"){$("playIcon").setAttribute("data-lucide","pause");$("stateBadge").textContent="PLAYING";lucide.createIcons();renderLibrary();}});
localAudio.addEventListener("pause",()=>{if(queueMode==="local"){$("playIcon").setAttribute("data-lucide","play");$("stateBadge").textContent="PAUSED";lucide.createIcons();renderLibrary();}});
localAudio.addEventListener("ended",()=>{if(queueMode!=="local")return;if(repeatMode){playQueueIndex(queueIndex);return;}nextLocal();});

async function refreshStatus(){try{const s=await api("/api/status");connected=!!s.spotify_connected;$("spotifyBtn").textContent=connected?"SPOTIFY CONNECTED":"CONNECT SPOTIFY";$("ollama").textContent=s.ollama_available?`Ollama: ${s.ollama_model}`:"Ollama: fallback mode";if(connected)initSpotifyPlayer();}catch(e){showError(e.message);}}
function connectSpotify(){location.href="/spotify/login";}
async function initSpotifyPlayer(){
  if(!connected||!window.Spotify||playerInitStarted)return;
  playerInitStarted=true;
  try{
    const token=await api("/api/spotify/token");
    spotifyPlayer=new Spotify.Player({name:"AIRGAP",getOAuthToken:cb=>cb(token.access_token),volume:.7,enableMediaSession:true});
    spotifyPlayer.addListener("ready",({device_id})=>{
      deviceId=device_id;
      setText("device","Spotify browser player ready");
      log("Spotify browser player ready");
    });
    spotifyPlayer.addListener("not_ready",()=>setText("device","Spotify browser player offline"));
    spotifyPlayer.addListener("authentication_error",e=>showError("Spotify authentication: "+e.message));
    spotifyPlayer.addListener("account_error",e=>showError("Spotify account: "+e.message));
    spotifyPlayer.addListener("playback_error",e=>{
      if(!String(e.message||"").toLowerCase().includes("interrupted"))showError("Spotify playback: "+e.message);
    });
    spotifyPlayer.addListener("player_state_changed",s=>{
      if(!s||queueMode==="local")return;
      const t=s.track_window?.current_track;
      if(t)setText("now",`${t.name} — ${t.artists.map(a=>a.name).join(", ")}`);
      setText("stateBadge",s.paused?"PAUSED":"PLAYING");
      const icon=$("playIcon");
      if(icon){icon.setAttribute("data-lucide",s.paused?"play":"pause");lucide.createIcons();}
      const position=Number(s.position||0);
      const duration=Number(s.duration||0);
      window.__airgapSpotifyDuration=duration;
      if(duration>0){
        setText("current",formatTime(position/1000));
        setText("total",formatTime(duration/1000));
        const bar=$("progress");
        if(bar)bar.style.width=Math.min(100,Math.max(0,(position/duration)*100))+"%";
      }else{
        setText("current","00:00");
        setText("total","00:00");
        const bar=$("progress");
        if(bar)bar.style.width="0%";
      }
    });
    const ok=await spotifyPlayer.connect();
    if(!ok)throw new Error("Spotify browser player could not connect.");
  }catch(e){playerInitStarted=false;showError(e.message);}
}

async function activatePlayback(){if(spotifyPlayer?.activateElement&&!playbackActivated){try{await spotifyPlayer.activateElement();playbackActivated=true;}catch(e){}}}
async function playSpotifyTrack(t){
  if(spotifyPlayInFlight)return;
  if(!t?.uri)return;
  if(!connected)return showError("Connect Spotify first.");
  if(!deviceId)return showError("Spotify browser player isn't ready yet. Wait a second after connecting.");
  spotifyPlayInFlight=true;
  const gen=++playbackGeneration;
  try{
    await activatePlayback();
    // Stop local HTML5 playback only. Never call the Spotify SDK pause() here.
    localAudio.pause();
    localAudio.currentTime=0;
    await api("/api/spotify/play",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({uri:t.uri,device_id:deviceId})});
    if(gen!==playbackGeneration)return;
    queueMode="spotify";
    spotifyIndex=spotifyTracks.findIndex(x=>x.id===t.id);
    setText("title",t.name);setText("artist",t.artists);
    const tag=$("playingTag");if(tag){tag.textContent="SPOTIFY";tag.className="px-2 py-1 rounded border border-green-500/20 bg-green-500/5 text-green-400";}
    setText("now",`${t.name} — ${t.artists}`);setText("stateBadge","PLAYING");
    showError("");
  }catch(e){
    if(!String(e.message||"").toLowerCase().includes("interrupted"))showError(e.message);
  }finally{spotifyPlayInFlight=false;}
}
async function playSpotifyIndex(i){
  const t=spotifyTracks[i];
  if(!t)return;
  await playSpotifyTrack(t);
}

function renderSpotifyResults(tracks){spotifyTracks=tracks||[];$("results").innerHTML=spotifyTracks.length?spotifyTracks.map((t,i)=>`<button class="track" data-i="${i}"><img src="${esc(t.image||"")}" onerror="this.style.visibility='hidden'"><span><b>${esc(t.name)}</b><small>${esc(t.artists)} • ${esc(t.album)}</small></span><strong>▶</strong></button>`).join(""):"<div class=\"muted\">No Spotify matches.</div>";document.querySelectorAll(".track").forEach(b=>b.onclick=()=>playSpotifyIndex(+b.dataset.i));$("count").textContent=`${spotifyTracks.length} tracks`;}
async function directSearch(){const q=$("musicq").value.trim();if(!q)return;try{const d=await api("/api/spotify/search?q="+encodeURIComponent(q));renderSpotifyResults(d.tracks||[]);}catch(e){showError(e.message);}}
async function askAI(text=null){
  const q=(text??$("aiText").value).trim();
  if(!q)return;
  const requestId=++aiRequestGeneration;
  $("aiText").value="";setText("transcript",`> ${q}`);setText("ai","Thinking…");
  try{
    const ctx={current:queueMode==="local"?queue[queueIndex]||null:spotifyTracks[spotifyIndex]||null,queue:queue.slice(0,30).map(t=>({title:t.title||t.name,artist:t.artist||t.artists,album:t.album,source:t.source||t.type})),recent:spotifyTracks.slice(0,10).map(t=>t.name||t.title),localLibrary:localTracks.slice(0,100).map(t=>({title:t.title,artist:t.artist,folder:t.folder}))};
    const d=await api("/api/ai?q="+encodeURIComponent(q)+"&context="+encodeURIComponent(JSON.stringify(ctx)));
    // If another request was submitted while Ollama/Spotify was working, discard this stale result.
    if(requestId!==aiRequestGeneration)return;
    const p=d.plan||{};
    const reply=p.reply||p.understanding||"I understood the request.";
    const ai=$("ai");if(ai)ai.innerHTML=`<div class="text-zinc-200">${esc(reply)}</div><div class="mt-2 text-zinc-600">${esc(p.understanding||q)}</div>`;
    log(`AI: ${reply}`);
    if(d.ai_error)log(`AI fallback: ${d.ai_error}`);
    if(p.needs_clarification){setVoiceState("idle");return;}
    // IMPORTANT: install this request's result set BEFORE selecting/playing its track.
    // The old code played by index against the previous request's spotifyTracks array,
    // which caused Bahubali -> Korean -> relaxing requests to play one request behind.
    if(d.tracks?.length)renderSpotifyResults(d.tracks);
    if(p.action==="play" && d.chosen){
      await playSpotifyTrack(d.chosen);
    }else if(p.action==="queue"&&d.tracks){
      d.tracks.forEach(t=>{if(!queue.some(x=>x.id===t.id))queue.push(t)});renderQueue();
    }else if(p.action==="pause"){await controlSpotify("pause");}
    else if(p.action==="resume"){await controlSpotify("resume");}
    else if(p.action==="stop"){await stopLocal();}
    else if(p.action==="next"){await controlSpotify("next");}
    else if(p.action==="previous"){await controlSpotify("previous");}
    else if(p.action==="shuffle"){shuffleQueue();}
  }catch(e){
    if(requestId!==aiRequestGeneration)return;
    showError(e.message);log("AI ERROR: "+e.message);setText("ai","AI couldn't complete that request.");
  }
}

function makeRecognition(){if(!SpeechRecognition)return null;const r=new SpeechRecognition();r.lang="en-US";r.continuous=false;r.interimResults=true;return r;}
function startVoice(){if(!SpeechRecognition)return showError("Voice input is not supported in this browser. Use Edge or Chrome.");voiceMode=true;recognition=makeRecognition();recognition.onstart=()=>{setVoiceState("listening");$("transcript").textContent="> Listening… speak now."};recognition.onresult=e=>{let t="";for(let i=e.resultIndex;i<e.results.length;i++)t+=e.results[i][0].transcript+" ";t=t.trim();if(t){$("transcript").textContent=`> ${t}`;recognition.stop();askAI(t);}};recognition.onerror=e=>{if(e.error!=="aborted"&&e.error!=="no-speech")showError("Voice: "+e.error)};recognition.onend=()=>{voiceMode=false;setVoiceState("idle")};try{recognition.start()}catch(e){}}
function setVoiceState(s){const wave=$("wave"),orb=$("orb");wave.className="wave "+s;orb.classList.toggle("listening",s==="listening");$("stateBadge").textContent=s.toUpperCase();}
function stopVoice(){voiceMode=false;commandMode=false;if(recognition)try{recognition.stop()}catch(e){}recognition=null;setVoiceState("idle");$("transcript").textContent="> Voice stopped.";}

window.onSpotifyWebPlaybackSDKReady=()=>initSpotifyPlayer();
window.addEventListener("load",()=>{
  lucide.createIcons();
  // Optional state targets used by the Spotify SDK. Keep them virtual so the
  // hardware UI does not need extra visible elements.
  if(!$("now")){const e=document.createElement("span");e.id="now";e.hidden=true;document.body.appendChild(e);}
  if(!$("device")){const e=document.createElement("span");e.id="device";e.hidden=true;document.body.appendChild(e);}
  // Add folder picker.
  const picker=document.createElement("input");picker.type="file";picker.multiple=true;picker.accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac,.aac";picker.setAttribute("webkitdirectory","");picker.setAttribute("directory","");picker.style.display="none";document.body.appendChild(picker);$("addFolder").onclick=()=>picker.click();picker.onchange=()=>{if(picker.files?.length)void addFolder(picker.files);picker.value="";};
  $("scan").onclick=()=>picker.click();
  $("voiceBtn").onclick=startVoice;$("modeBtn").onclick=()=>log("Wake word mode is UI-ready; push-to-talk is active in this build");
  $("aiSend").onclick=()=>askAI();$("aiText").addEventListener("keydown",e=>{if(e.key==="Enter")askAI();});
  $("search").onclick=directSearch;$("musicq").addEventListener("keydown",e=>{if(e.key==="Enter")directSearch();});$("spotifyBtn").onclick=connectSpotify;
  $("play").onclick=async()=>{
    if(queueMode==="local"){
      if(localAudio.paused){if(!localAudio.src&&queue.length)await playQueueIndex(queueIndex<0?0:queueIndex);else await localAudio.play();}
      else localAudio.pause();
    }else{
      const paused=$("stateBadge")?.textContent==="PAUSED";
      await controlSpotify(paused?"resume":"pause");
    }
  };
  $("stop").onclick=stopLocal;$("next").onclick=()=>queueMode==="local"?nextLocal():controlSpotify("next");$("prev").onclick=()=>queueMode==="local"?prevLocal():controlSpotify("previous");$("shuffle").onclick=shuffleQueue;$("repeat").onclick=()=>{repeatMode=!repeatMode;$("repeat").classList.toggle("border-orange-500",repeatMode);$("repeatState").textContent=repeatMode?"ON":"OFF";};
  $("playAll").onclick=()=>{queue=[...localTracks];shuffleMode=false;queueIndex=0;renderQueue();playQueueIndex(0);};$("clearQueue").onclick=()=>{queue=[];queueIndex=-1;renderQueue();log("queue cleared");};$("shuffleQueue").onclick=()=>{queue=[...localTracks];if(queue.length>1){for(let i=queue.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[queue[i],queue[j]]=[queue[j],queue[i]];}}queueIndex=0;queueMode="local";renderQueue();playQueueIndex(0);log("shuffled local library into playback queue");};
  // One scrubber for both local files and Spotify. Click or drag anywhere on the bar.
  const progressHit=$("progressHit");
  if(progressHit){
    let scrubbing=false;
    const seekFromPointer=e=>{
      const r=progressHit.getBoundingClientRect();
      const ratio=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
      if(queueMode==="local"&&Number.isFinite(localAudio.duration)&&localAudio.duration>0){
        localAudio.currentTime=ratio*localAudio.duration;
      }else if(queueMode==="spotify"&&spotifyPlayer){
        const duration=window.__airgapSpotifyDuration||0;
        if(duration>0)spotifyPlayer.seek(Math.round(ratio*duration)).catch(()=>{});
      }
      const bar=$("progress");
      if(bar)bar.style.width=(ratio*100)+"%";
    };
    progressHit.addEventListener("pointerdown",e=>{scrubbing=true;scrubbingGlobal=true;progressHit.setPointerCapture?.(e.pointerId);seekFromPointer(e);});
    progressHit.addEventListener("pointermove",e=>{if(scrubbing)seekFromPointer(e);});
    progressHit.addEventListener("pointerup",e=>{if(scrubbing){seekFromPointer(e);scrubbing=false;scrubbingGlobal=false;}});
    progressHit.addEventListener("pointercancel",()=>{scrubbing=false;scrubbingGlobal=false;});
    progressHit.tabIndex=0;
    progressHit.setAttribute("role","slider");
    progressHit.setAttribute("aria-label","Seek playback");
  };
  setInterval(async()=>{
    if(queueMode!=="spotify"||!spotifyPlayer||scrubbingGlobal)return;
    try{
      const s=await spotifyPlayer.getCurrentState();
      if(!s)return;
      const position=Number(s.position||0),duration=Number(s.duration||0);
      window.__airgapSpotifyDuration=duration;
      if(duration>0){
        setText("current",formatTime(position/1000));
        setText("total",formatTime(duration/1000));
        const bar=$("progress");
        if(bar)bar.style.width=Math.min(100,Math.max(0,(position/duration)*100))+"%";
      }
    }catch(e){}
  },500);
  refreshStatus();renderLibrary();renderQueue();setVoiceState("idle");
});
async function controlSpotify(action){if(!deviceId)return showError("Spotify player isn't ready.");try{await api("/api/spotify/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,device_id:deviceId})});}catch(e){showError(e.message);}}
