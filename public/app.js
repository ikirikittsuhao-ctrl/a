let supabaseClient=null;
let session=null;
let chats=[];
let activeChat=null;
let socket=null;
let authMode="login";

const $=id=>document.getElementById(id);
const auth=$("auth"), app=$("app"), messages=$("messages");

async function loadSupabase(){
  const r=await fetch("/api/health");
  if(!r.ok) throw new Error("Server unavailable");
  // Supabase browser SDK is loaded dynamically to keep the app server-controlled.
  const s=await fetch("/api/config").catch(()=>null);
}

function showAuth(msg=""){auth.classList.remove("hidden");app.classList.add("hidden");$("authMsg").textContent=msg}
function showApp(){auth.classList.add("hidden");app.classList.remove("hidden")}

async function api(url, options={}){
  const headers={"Content-Type":"application/json",...(options.headers||{})};
  if(session?.access_token) headers.Authorization=`Bearer ${session.access_token}`;
  const r=await fetch(url,{...options,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||"Request failed");
  return data;
}

/*
  Supabase JS is intentionally loaded from the official CDN.
  Set your Supabase project values below.
*/
const SUPABASE_URL=window.SCHAT_SUPABASE_URL||"";
const SUPABASE_ANON_KEY=window.SCHAT_SUPABASE_ANON_KEY||"";

async function init(){
  if(!SUPABASE_URL||!SUPABASE_ANON_KEY){
    showAuth("public/index.html の設定値にSupabase URL/Anon Keyを設定してください。");
    return;
  }
  const script=document.createElement("script");
  script.src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
  script.onload=async()=>{
    supabaseClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);
    const {data}=await supabaseClient.auth.getSession();
    session=data.session;
    if(session) await enter();
    else showAuth();
    supabaseClient.auth.onAuthStateChange(async(_,s)=>{
      session=s;
      if(s) await enter(); else showAuth();
    });
  };
  document.head.appendChild(script);
}

async function enter(){
  showApp();
  try{
    await api("/api/me");
    await loadChats();
    connectSocket();
  }catch(e){showAuth(e.message)}
}

$("loginTab").onclick=()=>{authMode="login";$("loginTab").classList.add("active");$("signupTab").classList.remove("active");document.querySelectorAll(".signupOnly").forEach(x=>x.classList.add("hidden"))};
$("signupTab").onclick=()=>{authMode="signup";$("signupTab").classList.add("active");$("loginTab").classList.remove("active");document.querySelectorAll(".signupOnly").forEach(x=>x.classList.remove("hidden"))};

$("authForm").onsubmit=async e=>{
  e.preventDefault();
  if(!supabaseClient){$("authMsg").textContent="Supabase設定を確認してください";return}
  $("authMsg").textContent="処理中...";
  const email=$("email").value.trim(), password=$("password").value;
  let result;
  if(authMode==="login") result=await supabaseClient.auth.signInWithPassword({email,password});
  else result=await supabaseClient.auth.signUp({email,password,options:{data:{display_name:$("displayName").value.trim()||"User"}}});
  if(result.error){$("authMsg").textContent=result.error.message;return}
  if(authMode==="signup"&&!result.data.session)$("authMsg").textContent="確認メールを確認してください。";
};

async function loadChats(){
  const d=await api("/api/chats");chats=d.chats||[];renderChats();
}
function renderChats(){
  $("chatList").innerHTML="";
  chats.forEach(c=>{
    const b=document.createElement("button");b.className="chat-item"+(activeChat?.id===c.id?" active":"");
    const a=document.createElement("div");a.className="avatar";a.innerHTML=c.type==="group"?'<i class="fa-solid fa-users"></i>':'<i class="fa-solid fa-user"></i>';
    const info=document.createElement("div");info.className="chat-info";
    const n=document.createElement("div");n.className="chat-name";n.textContent=c.name||"ダイレクトチャット";
    const t=document.createElement("div");t.className="chat-type";t.textContent=c.type==="group"?"グループ":"個人";
    info.append(n,t);b.append(a,info);b.onclick=()=>openChat(c);$("chatList").append(b);
  });
}
async function openChat(c){
  activeChat=c;renderChats();$("chatTitle").innerHTML=`<b>${escapeHTML(c.name||"ダイレクトチャット")}</b><span>${c.type==="group"?"グループ":"個人"}チャット</span>`;
  $("messageInput").disabled=false;$("composer").querySelector("button").disabled=false;
  const d=await api(`/api/chats/${c.id}/messages`);renderMessages(d.messages||[]);
  socket?.emit("join_chat",c.id);$("sidebar")?.classList.remove("open");
  document.querySelector(".sidebar").classList.remove("open");
}
function renderMessages(list){
  messages.innerHTML="";
  if(!list.length){messages.innerHTML='<div class="empty"><i class="fa-regular fa-message"></i><h2>まだメッセージはありません</h2><p>最初のメッセージを送ってみましょう。</p></div>';return}
  list.forEach(renderMessage);
  messages.scrollTop=messages.scrollHeight;
}
function renderMessage(m){
  if(!activeChat||m.chat_id!==activeChat.id)return;
  const row=document.createElement("div");row.className="message-row"+(m.sender_id===session.user.id?" mine":"");
  const wrap=document.createElement("div");wrap.className="bubble-wrap";
  if(m.sender_id!==session.user.id){const s=document.createElement("div");s.className="sender";s.textContent=m.profiles?.display_name||"User";wrap.append(s)}
  const b=document.createElement("div");b.className="bubble";b.textContent=m.body;
  const time=document.createElement("div");time.className="time";time.textContent=new Date(m.created_at).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"});
  wrap.append(b,time);row.append(wrap);messages.append(row);
  messages.scrollTop=messages.scrollHeight;
}
$("composer").onsubmit=async e=>{
  e.preventDefault();if(!activeChat)return;
  const input=$("messageInput"),body=input.value.trim();if(!body)return;
  input.value="";
  try{await api(`/api/chats/${activeChat.id}/messages`,{method:"POST",body:JSON.stringify({body})})}catch(err){alert(err.message)}
};

function connectSocket(){
  if(socket)return;
  const s=document.createElement("script");s.src="/socket.io/socket.io.js";s.onload=()=>{
    socket=io({auth:{access_token:session.access_token}});
    socket.on("message",m=>{if(!document.querySelector(`[data-message="${m.id}"]`))renderMessage(m)});
  };document.head.appendChild(s);
}

$("userSearch").oninput=async e=>{
  const q=e.target.value.trim(), box=$("searchResults");
  if(q.length<2){box.innerHTML="";return}
  try{
    const d=await api("/api/users/search?q="+encodeURIComponent(q));box.innerHTML="";
    d.users.forEach(u=>{
      const b=document.createElement("button");b.className="search-result";
      b.innerHTML=`<div class="avatar"><i class="fa-solid fa-user"></i></div><div><b>${escapeHTML(u.display_name)}</b><div class="chat-type">@${escapeHTML(u.username)}</div></div>`;
      b.onclick=async()=>{try{await api("/api/friends/add",{method:"POST",body:JSON.stringify({friend_id:u.id})});const d=await api("/api/chats/direct",{method:"POST",body:JSON.stringify({user_id:u.id})});await loadChats();openChat(d.chat);box.innerHTML="";$("userSearch").value=""}catch(err){alert(err.message)}};
      box.append(b);
    });
  }catch{}
};

$("newGroup").onclick=()=>{
  showModal(`<h2>グループを作成</h2><div class="profile-box"><input id="groupName" placeholder="グループ名" maxlength="80"><input id="groupUsers" placeholder="メンバーUUID（カンマ区切り）"><div class="modal-actions"><button onclick="closeModal()">キャンセル</button><button class="primary" id="createGroupBtn">作成</button></div></div>`);
  $("createGroupBtn").onclick=async()=>{try{const ids=$("groupUsers").value.split(",").map(x=>x.trim()).filter(Boolean);const d=await api("/api/chats/group",{method:"POST",body:JSON.stringify({name:$("groupName").value,user_ids:ids})});closeModal();await loadChats();openChat(d.chat)}catch(e){alert(e.message)}};
};

$("qrBtn").onclick=async()=>{
  showModal(`<h2>QRフレンド</h2><p class="muted">自分のQRを表示するか、QRトークンを入力して友だち追加できます。</p><div class="modal-actions"><button class="primary" id="makeQR">自分のQRを表示</button></div><input id="qrToken" placeholder="QRトークンを貼り付け"><div class="modal-actions"><button id="redeemQR">追加</button></div><div id="qrArea"></div>`);
  $("makeQR").onclick=async()=>{try{const d=await api("/api/qr/create",{method:"POST"});$("qrArea").innerHTML=`<img class="qr" src="${d.qr}" alt="schat friend QR"><p class="muted">10分で期限切れになります。</p>`}catch(e){alert(e.message)}};
  $("redeemQR").onclick=async()=>{try{let v=$("qrToken").value.trim();if(v.startsWith("schat://friend/"))v=v.split("/").pop();await api("/api/qr/redeem",{method:"POST",body:JSON.stringify({token:v})});alert("フレンドを追加しました");closeModal()}catch(e){alert(e.message)}};
};

$("logout").onclick=async()=>{await supabaseClient?.auth.signOut();location.reload()};
$("profileBtn").onclick=$("mobileProfile").onclick=async()=>{
  const d=await api("/api/me");showModal(`<h2>プロフィール</h2><div class="profile-box"><div class="avatar" style="width:64px;height:64px"><i class="fa-solid fa-user"></i></div><input id="profileName" value="${escapeAttr(d.profile.display_name)}" maxlength="50"><div class="modal-actions"><button onclick="closeModal()">閉じる</button><button class="primary" id="saveProfile">保存</button></div></div>`);
  $("saveProfile").onclick=async()=>{try{await api("/api/me",{method:"PATCH",body:JSON.stringify({display_name:$("profileName").value})});closeModal()}catch(e){alert(e.message)}};
};
$("mobileMenu").onclick=()=>document.querySelector(".sidebar").classList.toggle("open");
$("modalClose").onclick=closeModal;
function showModal(html){$("modalContent").innerHTML=html;$("modal").classList.remove("hidden")}
function closeModal(){$("modal").classList.add("hidden")}
function escapeHTML(s){const d=document.createElement("div");d.textContent=s??"";return d.innerHTML}
function escapeAttr(s){return String(s??"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}

init();
