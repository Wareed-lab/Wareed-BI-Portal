(function(){
  'use strict';
  const CONFIG=window.WAREED_PORTAL_CONFIG||{};
  const SESSION_KEY='wareedBiWebSessionV1';
  const VIEW_LABELS={home:'الرئيسية',executive:'التقرير التنفيذي',daily:'التقرير اليومي',salesComparison:'مركز المقارنات',monthly:'التقرير الشهري',reservations:'تقرير الحجوزات',archive:'التقارير السابقة',send:'إرسال تقرير',recipients:'مستلمو التقارير',diagnostics:'التشخيص',settings:'الإعدادات'};
  const ACTION_LABELS={refresh:'تحديث البيانات',sendReport:'إرسال التقارير',download:'تنزيل التقارير',archive:'طلب التقارير السابقة',manageRecipients:'إدارة المستلمين',manageAutomation:'إدارة الجدولة',diagnostics:'عرض التشخيص'};
  const ACTION_MAP={appBootstrap:'webBootstrap',appSendReport:'webSendReport',appSendStatus:'webSendStatus',appRefreshReport:'webRefreshReport',appArchiveReport:'webArchiveReport',appArchiveContent:'webArchiveContent',appRecipientChange:'webRecipientChange',appSaveAutomation:'webSaveAutomation'};
  let session=null;
  let users=[];
  let originalPortableCall=null;

  function readSession(){try{const value=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');return value&&value.token?value:null}catch(_){return null}}
  function saveSession(value){session=value;if(value)localStorage.setItem(SESSION_KEY,JSON.stringify(value));else localStorage.removeItem(SESSION_KEY)}
  function deviceId(){let id=localStorage.getItem('wareedBiDeviceId');if(!id){id='web-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);localStorage.setItem('wareedBiDeviceId',id)}return id}
  async function request(action,payload,withToken=true){
    if(!CONFIG.endpoint)throw new Error('رابط خدمة Wareed غير مهيأ.');
    const body={action,...(payload||{})};
    if(withToken&&session?.token)body.token=session.token;
    const response=await fetch(CONFIG.endpoint,{method:'POST',redirect:'follow',cache:'no-store',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body)});
    const text=await response.text();let result;
    try{result=JSON.parse(text)}catch(_){throw new Error('تعذر قراءة رد خدمة Wareed.');}
    if(!response.ok||result.ok!==true)throw new Error(result.error||'تعذر الاتصال بخدمة Wareed.');
    return result;
  }
  function gate(){return document.getElementById('wareedPortalGate')}
  function showGate(message){
    document.body.classList.add('portal-locked');
    gate().hidden=false;
    const error=document.getElementById('portalLoginError');if(error)error.textContent=message||'';
    setTimeout(()=>document.getElementById('portalUsername')?.focus(),50);
  }
  function hideGate(){gate().hidden=true;document.body.classList.remove('portal-locked')}
  function injectGate(){
    const node=document.createElement('div');node.id='wareedPortalGate';node.innerHTML='<form class="portal-login-card" id="portalLoginForm"><div class="portal-login-brand">W</div><h1>Wareed BI Report</h1><p>سجّل الدخول لعرض التقارير المصرح بها. البيانات لا تُحمّل قبل التحقق من الحساب.</p><div class="portal-login-field"><label>اسم المستخدم</label><input id="portalUsername" autocomplete="username" required></div><div class="portal-login-field"><label>كلمة المرور</label><input id="portalPassword" type="password" autocomplete="current-password" required></div><button class="portal-login-submit" id="portalLoginButton" type="submit">تسجيل الدخول</button><p class="portal-login-error" id="portalLoginError"></p></form>';
    document.body.prepend(node);document.getElementById('portalLoginForm').addEventListener('submit',login);
  }
  async function login(event){
    event.preventDefault();const button=document.getElementById('portalLoginButton'),error=document.getElementById('portalLoginError');button.disabled=true;error.textContent='جارٍ التحقق...';
    try{
      const username=document.getElementById('portalUsername').value.trim(),password=document.getElementById('portalPassword').value;
      const result=await request('webLogin',{username,password,deviceId:deviceId()},false);
      document.getElementById('portalPassword').value='';saveSession({token:result.token,expiresAt:result.expiresAt,user:result.user});await loadBootstrap(false);
    }catch(err){error.textContent=err.message||'تعذر تسجيل الدخول.'}finally{button.disabled=false}
  }
  async function logout(){
    try{if(session?.token)await request('webLogout',{})}catch(_){}saveSession(null);clearInterval(window.PORTABLE_LIVE_TIMER);showGate('تم تسجيل الخروج.');
  }
  function permissions(){return session?.user?.permissions||{views:[],actions:[]}}
  function canView(view){return session?.user?.role==='owner'||permissions().views?.includes(view)}
  function canAction(action){return session?.user?.role==='owner'||permissions().actions?.includes(action)}
  function applyPermissions(){
    document.querySelectorAll('.nav[data-page]').forEach(node=>{const page=node.dataset.page;node.hidden=page==='users'?session?.user?.role!=='owner':!canView(page)});
    document.querySelectorAll('[data-owner-only]').forEach(node=>{if(node.matches('[data-page]'))return;node.hidden=session?.user?.role!=='owner'});
    const refresh=document.querySelector('.top .icon[onclick*="refreshData"]');if(refresh)refresh.hidden=!canAction('refresh');
    if(!canView(window.CURRENT_PAGE||'home')){
      const first=(permissions().views||[]).find(view=>document.getElementById(view))||'home';window.go(first);
    }
  }
  function installSessionHeader(){
    let badge=document.getElementById('portalSessionBadge');if(badge)return;
    badge=document.createElement('div');badge.id='portalSessionBadge';badge.className='portal-session-badge';badge.innerHTML='<span id="portalSessionName"></span><button class="portal-logout" type="button">تسجيل الخروج</button>';
    badge.querySelector('button').addEventListener('click',logout);document.querySelector('.top')?.appendChild(badge);
  }
  function installHooks(){
    window.applyRolePermissions=applyPermissions;
    window.renderUsers=renderUsers;
    window.saveUser=saveUser;
    window.toggleUser=editUser;
    window.portableCloudPost=async function(body){return request(ACTION_MAP[body.action]||body.action,Object.fromEntries(Object.entries(body).filter(([key])=>key!=='action')))};
    originalPortableCall=window.portableCall;
    window.portableCall=function(name,arg){
      if(name==='pageChanged'&&arg==='users'&&session?.user?.role==='owner')loadUsers();
      if(name==='refreshReport'&&!canAction('refresh'))return window.toast('لا تملك صلاحية التحديث');
      if(name==='sendReport'&&!canAction('sendReport'))return window.toast('لا تملك صلاحية الإرسال');
      if(name==='requestArchive'&&!canAction('archive'))return window.toast('لا تملك صلاحية طلب الأرشيف');
      if(name==='exportReport'&&!canAction('download'))return window.toast('لا تملك صلاحية التنزيل');
      if(name==='manageCloud')return handleManageCloud(arg);
      if(name==='clearDiagnostics'){localStorage.removeItem('wareedDiagnostics');return window.renderDiagnostics()}
      return originalPortableCall?originalPortableCall(name,arg):undefined;
    };
  }
  async function handleManageCloud(raw){
    const value=typeof raw==='string'?JSON.parse(raw):raw||{};
    try{
      if(value.command==='recipient'){
        if(!canAction('manageRecipients'))throw new Error('لا تملك صلاحية إدارة المستلمين.');
        const result=await request('webRecipientChange',{...value,action:undefined});window.cloudAdminUpdate?.('recipient','queued',30,'تم قبول تعديل المستلمين');return result;
      }
      if(value.command==='automation'){
        if(!canAction('manageAutomation'))throw new Error('لا تملك صلاحية إدارة الجدولة.');
        const result=await request('webSaveAutomation',{config:value.config});window.cloudAdminUpdate?.('automation','queued',30,'تم قبول تعديل الجدولة');return result;
      }
      throw new Error('الإجراء غير مدعوم من نسخة الويب.');
    }catch(err){window.toast(err.message)}
  }
  async function loadBootstrap(silent){
    try{
      const result=await request('webBootstrap',{});session.user=result.user;saveSession(session);window.applyCloudBootstrap(result);window.applyLocalConfig({cloudEndpoint:CONFIG.endpoint,liveIntervalMinutes:1},{name:result.user.username,email:result.user.username,role:result.user.role},[]);installSessionHeader();document.getElementById('portalSessionName').textContent=result.user.username;applyPermissions();if(result.user.role==='owner')renderAdminShell();hideGate();if(!silent)window.toast('تم تسجيل الدخول بنجاح');return result;
    }catch(err){saveSession(null);showGate(err.message);return null}
  }
  function renderAdminShell(){
    const section=document.getElementById('users');if(!section)return;
    section.innerHTML='<div class="hero"><h1>إدارة المستخدمين والصلاحيات</h1><p>هذه الصفحة خاصة بحساب المالك فقط</p></div><div class="section"><div class="section-head"><h2 id="portalUserFormTitle">إضافة مستخدم</h2><button class="soft" type="button" onclick="WareedPortal.resetUserForm()">مستخدم جديد</button></div><input type="hidden" id="portalUserId"><div class="portal-admin-grid"><label>اسم المستخدم<input id="portalUserName" dir="ltr" autocomplete="off" placeholder="username"></label><label>كلمة المرور<input id="portalUserPassword" dir="ltr" type="password" autocomplete="new-password" placeholder="مطلوبة للجديد، واتركها فارغة عند عدم التغيير"></label><label class="full"><span><input type="checkbox" id="portalUserEnabled" checked> الحساب مفعل</span></label></div><div class="portal-permission-groups"><div class="portal-permission-box"><h3>الصفحات التي يستطيع فتحها</h3><div class="portal-permission-list" id="portalViewPermissions"></div></div><div class="portal-permission-box"><h3>الإجراءات التي يستطيع تنفيذها</h3><div class="portal-permission-list" id="portalActionPermissions"></div></div></div><div class="portal-admin-actions"><button class="primary" type="button" onclick="WareedPortal.saveUser()">حفظ المستخدم والصلاحيات</button><button class="soft" type="button" onclick="WareedPortal.resetUserForm()">إلغاء التعديل</button></div><p class="subtle" id="portalUserMessage"></p></div><div class="section"><div class="section-head"><h2>المستخدمون</h2><span class="pill" id="portalUsersCount">0</span></div><div class="table-scroll"><table class="portal-users-table"><thead><tr><th>المستخدم</th><th>الحالة</th><th>الدور</th><th>الصفحات</th><th>الإجراءات</th><th>آخر دخول</th><th>التحكم</th></tr></thead><tbody id="portalUsersBody"></tbody></table></div></div>';
    document.getElementById('portalViewPermissions').innerHTML=Object.entries(VIEW_LABELS).map(([key,label])=>'<label><input type="checkbox" name="portalView" value="'+key+'"> '+label+'</label>').join('');
    document.getElementById('portalActionPermissions').innerHTML=Object.entries(ACTION_LABELS).map(([key,label])=>'<label><input type="checkbox" name="portalAction" value="'+key+'"> '+label+'</label>').join('');
    resetUserForm();
  }
  async function loadUsers(){try{const result=await request('webListUsers',{});users=result.users||[];renderUsers()}catch(err){window.toast(err.message)}}
  function renderUsers(){
    const body=document.getElementById('portalUsersBody');if(!body)return;
    document.getElementById('portalUsersCount').textContent=users.length;
    body.innerHTML=users.map(user=>'<tr class="'+(user.enabled?'':'portal-user-off')+'"><td><b dir="ltr">'+window.escapeHtml(user.username)+'</b></td><td>'+(user.enabled?'مفعل':'موقوف')+'</td><td><span class="portal-role '+user.role+'">'+(user.role==='owner'?'المالك':'مستخدم')+'</span></td><td>'+((user.permissions?.views||[]).length)+' صفحة</td><td>'+((user.permissions?.actions||[]).length)+' إجراء</td><td dir="ltr">'+(user.lastLoginAt?new Date(user.lastLoginAt).toLocaleString('ar-SA'):'—')+'</td><td><div class="portal-user-actions"><button class="soft" onclick="WareedPortal.editUser(\''+window.escapeJs(user.id)+'\')">تعديل</button>'+(user.role==='owner'?'':'<button class="soft danger" onclick="WareedPortal.deleteUser(\''+window.escapeJs(user.username)+'\')">حذف</button>')+'</div></td></tr>').join('')||'<tr><td colspan="7">لا يوجد مستخدمون</td></tr>';
  }
  function resetUserForm(){
    ['portalUserId','portalUserName','portalUserPassword'].forEach(id=>{const node=document.getElementById(id);if(node)node.value=''});const enabled=document.getElementById('portalUserEnabled');if(enabled)enabled.checked=true;document.querySelectorAll('[name=portalView],[name=portalAction]').forEach(node=>node.checked=false);const title=document.getElementById('portalUserFormTitle');if(title)title.textContent='إضافة مستخدم';
  }
  function editUser(id){
    const user=users.find(item=>item.id===id);if(!user)return;document.getElementById('portalUserId').value=user.id;document.getElementById('portalUserName').value=user.username;document.getElementById('portalUserPassword').value='';document.getElementById('portalUserEnabled').checked=user.enabled;document.querySelectorAll('[name=portalView]').forEach(node=>node.checked=user.permissions?.views?.includes(node.value));document.querySelectorAll('[name=portalAction]').forEach(node=>node.checked=user.permissions?.actions?.includes(node.value));document.getElementById('portalUserFormTitle').textContent='تعديل '+user.username;scrollTo({top:document.getElementById('users').offsetTop,behavior:'smooth'});
  }
  async function saveUser(){
    const message=document.getElementById('portalUserMessage');message.textContent='جارٍ الحفظ...';
    const user={id:document.getElementById('portalUserId').value,username:document.getElementById('portalUserName').value.trim(),password:document.getElementById('portalUserPassword').value,enabled:document.getElementById('portalUserEnabled').checked,permissions:{views:[...document.querySelectorAll('[name=portalView]:checked')].map(node=>node.value),actions:[...document.querySelectorAll('[name=portalAction]:checked')].map(node=>node.value)}};
    try{const result=await request('webUpsertUser',{user});document.getElementById('portalUserPassword').value='';message.textContent='تم حفظ '+result.user.username;resetUserForm();await loadUsers();if(result.user.id===session.user.id){window.toast('تم تعديل حساب المالك. سجّل الدخول مجددًا إذا تغيرت كلمة المرور.')}}catch(err){message.textContent=err.message}
  }
  async function deleteUser(username){if(!confirm('حذف المستخدم '+username+' نهائيًا؟'))return;try{await request('webDeleteUser',{username});window.toast('تم حذف المستخدم');await loadUsers()}catch(err){window.toast(err.message)}}
  async function start(){
    injectGate();installHooks();session=readSession();
    if(session?.token){const result=await loadBootstrap(true);if(result){window.startPortableLive();return}}
    showGate('');
  }
  window.WareedPortal={start,request,logout,loadUsers,renderUsers,editUser,deleteUser,saveUser,resetUserForm,permissions,canView,canAction};
})();
