import { supabase } from './supabase.js'

const $ = (id) => document.getElementById(id)
const authView = $('authView'), roomView = $('roomView'), authStatus = $('authStatus'), roomStatus = $('roomStatus')
let profile = null, room = null, localStream = null, channel = null, peers = new Map(), participants = new Map(), micMode = 'open', micEnabled = true, audioEnabled = true

function msg(el, text, error=false){ el.textContent = text; el.style.color = error ? '#ff8f9a' : '#b9c4d6' }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

async function validateKey(key){
  const {data,error}=await supabase.rpc('validate_access_key',{p_key:key})
  if(error) throw error
  if(!data?.valid) throw new Error('Key inválida, expirada ou já utilizada.')
  return data
}

$('signupForm').addEventListener('submit', async e=>{
  e.preventDefault(); msg(authStatus,'Validando key...')
  const key=$('accessKey').value.trim(), username=$('username').value.trim(), password=$('password').value
  try{
    await validateKey(key)
    msg(authStatus,'Criando conta...')
    const email=`${crypto.randomUUID()}@example.com`
    const {data,error}=await supabase.auth.signUp({email,password,options:{data:{username}}})
    if(error) throw error
    if(!data.user) throw new Error('Não foi possível criar o usuário.')
    const {data:claim,error:claimError}=await supabase.rpc('claim_access_key',{p_key:key,p_user_id:data.user.id,p_username:username})
    if(claimError || !claim?.success) throw new Error(claimError?.message || 'Não foi possível vincular a key.')
    msg(authStatus,'Conta criada. Entrando na sala...')
    await loadRoom()
  }catch(err){ msg(authStatus,err.message||String(err),true) }
})

async function loadRoom(){
  const {data:{user}}=await supabase.auth.getUser(); if(!user) return
  const {data,error}=await supabase.from('profiles').select('id,username,is_admin,room_id,created_at').eq('id',user.id).single()
  if(error) throw error
  profile=data
  if(!profile.room_id) throw new Error('Usuário sem sala vinculada.')
  const {data:r,error:re}=await supabase.from('rooms').select('id,name').eq('id',profile.room_id).single(); if(re) throw re
  room=r
  authView.classList.add('hidden'); roomView.classList.remove('hidden')
  $('roomName').textContent=room.name; $('identity').textContent=`${profile.username}${profile.is_admin?' · ADMIN':''}`
  await enterVoice()
}

async function enterVoice(){
  localStream=await navigator.mediaDevices.getUserMedia({audio:true})
  setMicTrack(micEnabled && (micMode==='open'))
  channel=supabase.channel(`voice:${room.id}`,{config:{broadcast:{self:false},presence:{key:profile.id}}})
  channel.on('broadcast',{event:'signal'},async({payload})=>{
    if(payload.to===profile.id) await handleSignal(payload)
  }).on('presence',{event:'sync'},()=>renderPresence())
    .on('presence',{event:'join'},({key})=>{ if(key!==profile.id) ensurePeer(key,true) })
    .on('presence',{event:'leave'},({key})=>removePeer(key))
  await channel.subscribe(async status=>{ if(status==='SUBSCRIBED') await channel.track({username:profile.username,is_admin:profile.is_admin}) })
  msg(roomStatus,'Conectado à sala.')
  document.addEventListener('keydown',pttDown); document.addEventListener('keyup',pttUp)
}

function setMicTrack(enabled){ localStream?.getAudioTracks().forEach(t=>t.enabled=enabled); micEnabled=enabled; $('micBtn').textContent=enabled?'🎙️ Microfone ligado':'🔇 Microfone mutado' }
function setRemoteAudio(enabled){ audioEnabled=enabled; for(const pc of peers.values()) for(const r of pc.getReceivers()) if(r.track) r.track.enabled=enabled; $('audioBtn').textContent=enabled?'🔊 Áudio ligado':'🔇 Áudio mutado' }
function updateBoth(){ $('bothBtn').textContent=(!micEnabled&&!audioEnabled)?'🔊 Desmutar os dois':'🔇 Mutar os dois' }
$('micBtn').onclick=()=>{ if(micMode==='ptt'){setMicTrack(!micEnabled)} else setMicTrack(!micEnabled); updateBoth() }
$('audioBtn').onclick=()=>{setRemoteAudio(!audioEnabled);updateBoth()}
$('bothBtn').onclick=()=>{const mute=micEnabled||audioEnabled;setMicTrack(!mute);setRemoteAudio(!mute);updateBoth()}
$('micMode').onchange=e=>{micMode=e.target.value; if(micMode==='open') setMicTrack(true); else setMicTrack(false); updateBoth()}
function pttDown(e){ if(micMode==='ptt'&&e.code==='Space'&&!e.repeat){e.preventDefault();setMicTrack(true)} }
function pttUp(e){ if(micMode==='ptt'&&e.code==='Space'){e.preventDefault();setMicTrack(false)} }

function makePeer(id,initiator){
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]})
  localStream.getTracks().forEach(t=>pc.addTrack(t,localStream))
  pc.onicecandidate=e=>{if(e.candidate) sendSignal({to:id,type:'ice',candidate:e.candidate})}
  pc.ontrack=e=>{
    let audio=document.querySelector(`audio[data-peer="${id}"]`)
    if(!audio){audio=document.createElement('audio');audio.autoplay=true;audio.dataset.peer=id;audio.style.display='none';document.body.appendChild(audio)}
    audio.srcObject=e.streams[0]; audio.muted=!audioEnabled
  }
  pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState)) removePeer(id)}
  peers.set(id,pc)
  if(initiator) pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>sendSignal({to:id,type:'offer',sdp:pc.localDescription}))
  return pc
}
async function ensurePeer(id,initiator=false){ if(id===profile.id) return peers.get(id); if(peers.has(id)) return peers.get(id); return makePeer(id,initiator) }
async function sendSignal(payload){ await channel.send({type:'broadcast',event:'signal',payload:{...payload,from:profile.id}}) }
async function handleSignal(p){
  const pc=await ensurePeer(p.from,false)
  if(p.type==='offer'){await pc.setRemoteDescription(p.sdp);const a=await pc.createAnswer();await pc.setLocalDescription(a);await sendSignal({to:p.from,type:'answer',sdp:pc.localDescription})}
  else if(p.type==='answer') await pc.setRemoteDescription(p.sdp)
  else if(p.type==='ice'&&p.candidate) await pc.addIceCandidate(p.candidate)
}
function removePeer(id){const pc=peers.get(id);if(pc) pc.close();peers.delete(id);document.querySelector(`audio[data-peer="${id}"]`)?.remove();renderPresence()}
async function renderPresence(){
  const state=channel?.presenceState()||{}
  const entries=Object.entries(state).map(([id,arr])=>({id,...(arr[0]||{})}));
  $('participants').innerHTML=entries.map(x=>`<div class="participant"><span>👤 ${escapeHtml(x.username||'Usuário')}</span><span class="badge">${x.is_admin?'ADMIN':''}</span></div>`).join('')||'<div class="muted">Ninguém conectado.</div>'
  for(const x of entries) if(x.id!==profile.id) ensurePeer(x.id,true)
}
$('logoutBtn').onclick=async()=>{try{await channel?.unsubscribe();localStream?.getTracks().forEach(t=>t.stop());for(const pc of peers.values())pc.close();peers.clear();await supabase.auth.signOut();location.reload()}catch(e){msg(roomStatus,e.message,true)}}

supabase.auth.onAuthStateChange(async(_event,session)=>{ if(session&&!profile){try{await loadRoom()}catch(e){msg(authStatus,e.message,true)}} })

try{const {data:{session}}=await supabase.auth.getSession();if(session) await loadRoom()}catch(e){msg(authStatus,e.message,true)}
