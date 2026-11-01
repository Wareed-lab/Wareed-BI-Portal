(function(){
  'use strict';
  const CONFIG=window.WAREED_PORTAL_CONFIG||{};
  const SESSION_KEY='wareedBiWebSessionV1';
  const DIAGNOSTICS_KEY='wareedDiagnostics';
  const DIAGNOSTICS_LIMIT=60;
  const VIEW_LABELS={home:'الرئيسية',executive:'التقرير التنفيذي',daily:'التقرير اليومي',salesComparison:'مركز المقارنات',ai:'Wareed AI',monthly:'التقرير الشهري',reservations:'تقرير الحجوزات',archive:'التقارير السابقة',send:'إرسال تقرير',recipients:'مستلمو التقارير',diagnostics:'التشخيص',settings:'الإعدادات',regions:'المناطق'};
  const ACTION_LABELS={refresh:'تحديث البيانات',sendReport:'إرسال التقارير',download:'تنزيل التقارير',archive:'طلب التقارير السابقة',manageRecipients:'إدارة المستلمين',manageAutomation:'إدارة الجدولة',diagnostics:'عرض التشخيص',manageAreas:'إدارة مستخدمي المناطق'};
  const ACTION_MAP={appBootstrap:'webBootstrap',appSendReport:'webSendReport',appSendStatus:'webSendStatus',appRefreshReport:'webRefreshReport',appArchiveReport:'webArchiveReport',appArchiveContent:'webArchiveContent',appRecipientChange:'webRecipientChange',appSaveAutomation:'webSaveAutomation'};
  let session=null;
  let users=[];
  let originalPortableCall=null;
  let userFormTouched=false;
  let usersLoadPromise=null;
  let usersLoadedAt=0;
  let aiStatus=null;
  let areaPayload=null;
  let areaGroups=[];
  let areaCatalog=[];
  let areaSelectedBranches=new Set();

  function diagnostics(){try{const value=JSON.parse(localStorage.getItem(DIAGNOSTICS_KEY)||'[]');return Array.isArray(value)?value:[]}catch(_){return []}}
  function redactDiagnosticText(value){
    return String(value??'')
      .replace(/("?(?:password|token|appKey|authorization)"?\s*[:=]\s*")([^"]*)/gi,'$1[hidden]')
      .replace(/([?&](?:token|appKey|code)=)[^&\s]+/gi,'$1[hidden]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi,'$1[hidden]')
      .slice(0,900);
  }
  function endpointLabel(){try{const url=new URL(String(CONFIG.endpoint||''),location.href);return url.origin+url.pathname}catch(_){return 'غير مهيأ'}}
  function recordDiagnostic(level,code,message,details){
    const item={at:new Date().toISOString(),level:level||'error',code:code||'WEB-UNKNOWN',message:redactDiagnosticText(message||'حدث خطأ في نسخة الويب'),details:redactDiagnosticText(details||'')};
    const items=diagnostics();
    const last=items[items.length-1];
    if(last&&last.code===item.code&&last.message===item.message&&Date.now()-Date.parse(last.at||0)<30000)items[items.length-1]=item;else items.push(item);
    const limited=items.slice(-DIAGNOSTICS_LIMIT);
    try{localStorage.setItem(DIAGNOSTICS_KEY,JSON.stringify(limited))}catch(_){}
    if(typeof window.onDiagnostic==='function')window.onDiagnostic(item);
    return item;
  }
  function requestError(message,meta){const error=new Error(message);Object.assign(error,meta||{});return error}
  function requestCode(action,suffix){const name=String(action||'REQUEST').replace(/^web/i,'').replace(/([a-z])([A-Z])/g,'$1-$2').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'').toUpperCase()||'REQUEST';return 'WEB-'+name+'-'+suffix}

  function readSession(){try{const value=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');return value&&value.token?value:null}catch(_){return null}}
  function saveSession(value){session=value;if(value)localStorage.setItem(SESSION_KEY,JSON.stringify(value));else localStorage.removeItem(SESSION_KEY)}
  function deviceId(){let id=localStorage.getItem('wareedBiDeviceId');if(!id){id='web-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);localStorage.setItem('wareedBiDeviceId',id)}return id}
  async function request(action,payload,withToken=true){
    if(!CONFIG.endpoint){
      const error=requestError('رابط خدمة Wareed غير مهيأ.',{code:'WEB-CONFIG-ENDPOINT-MISSING',diagnosticRecorded:true});
      recordDiagnostic('error',error.code,error.message,'لم يتم العثور على رابط Google Apps Script في إعدادات النسخة المستضافة.');
      throw error;
    }
    const body={action,...(payload||{})};
    if(withToken&&session?.token)body.token=session.token;
    const started=Date.now(),timeoutMs=action==='webAskAi'?45000:30000,attempts=action==='webAskAi'?2:1;let response,lastCause;
    for(let attempt=1;attempt<=attempts&&!response;attempt++){
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),timeoutMs);
      try{response=await fetch(CONFIG.endpoint,{method:'POST',redirect:'follow',cache:'no-store',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(body),signal:controller.signal})}
      catch(cause){lastCause=cause;if(attempt<attempts&&cause?.name!=='AbortError')await new Promise(resolve=>setTimeout(resolve,650))}
      finally{clearTimeout(timeout)}
    }
    if(!response){
      const timedOut=lastCause?.name==='AbortError',code=requestCode(action,timedOut?'TIMEOUT':'NETWORK');
      const message=timedOut?'انتهت مهلة اتصال خدمة Wareed بعد '+Math.round(timeoutMs/1000)+' ثانية.':'تعذر الوصول إلى خدمة Wareed: '+String(lastCause?.message||'فشل اتصال الشبكة');
      const error=requestError(message,{code,diagnosticRecorded:true,cause:lastCause});
      recordDiagnostic('error',code,message,'العملية: '+action+' • المحاولات: '+attempts+' • الاتصال بالإنترنت: '+(navigator.onLine?'متاح':'غير متاح')+' • الرابط: '+endpointLabel());
      throw error;
    }
    const text=await response.text();let result;
    try{result=JSON.parse(text)}catch(_){
      const code=requestCode(action,'INVALID-RESPONSE');
      const message='وصل رد غير مفهوم من خدمة Wareed (HTTP '+response.status+').';
      const error=requestError(message,{code,diagnosticRecorded:true,httpStatus:response.status});
      recordDiagnostic('error',code,message,'العملية: '+action+' • نوع الرد: '+String(response.headers.get('content-type')||'غير معروف')+' • المدة: '+(Date.now()-started)+'ms • بداية الرد: '+redactDiagnosticText(text.slice(0,240)));
      throw error;
    }
    if(!response.ok||result.ok!==true){
      const code=String(result.code||requestCode(action,response.ok?'SERVICE':'HTTP-'+response.status));
      const message=String(result.error||('تعذر الاتصال بخدمة Wareed (HTTP '+response.status+').'));
      const error=requestError(message,{code,diagnosticRecorded:true,httpStatus:response.status});
      recordDiagnostic(response.status>=500?'error':'warning',code,message,'العملية: '+action+' • HTTP: '+response.status+' • المدة: '+(Date.now()-started)+'ms • وقت الخادم: '+String(result.serverTime||'غير متاح'));
      throw error;
    }
    return result;
  }
  function isSessionFailure(error){
    const message=String(error?.message||error||'');
    return /يلزم تسجيل الدخول|انتهت الجلسة|الحساب غير مفعل|Sign-in is required|Session expired|User is disabled/i.test(message);
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
      document.getElementById('portalPassword').value='';saveSession({token:result.token,expiresAt:result.expiresAt,user:result.user});activateSessionShell(result.user,'تم تسجيل الدخول • جارٍ تحميل أحدث التقارير...');void loadBootstrap(false);
    }catch(err){error.textContent=err.message||'تعذر تسجيل الدخول.'}finally{button.disabled=false}
  }
  async function logout(){
    try{if(session?.token)await request('webLogout',{})}catch(_){}saveSession(null);clearInterval(window.PORTABLE_LIVE_TIMER);showGate('تم تسجيل الخروج.');
  }
  function permissions(){return session?.user?.permissions||{views:[],actions:[]}}
  function canView(view){return session?.user?.role==='owner'||permissions().views?.includes(view)}
  function canAction(action){return session?.user?.role==='owner'||permissions().actions?.includes(action)}
  async function askAi(question,history){
    if(!canView('ai'))throw new Error('لا تملك صلاحية استخدام Wareed AI.');
    const cleanHistory=(Array.isArray(history)?history:[]).slice(-6).map(item=>({role:item?.role==='assistant'?'assistant':'user',text:String(item?.text||'').slice(0,700)}));
    try{return await request('webAskAi',{question:String(question||'').slice(0,600),history:cleanHistory})}
    catch(error){if(!error.diagnosticRecorded)recordDiagnostic('error',error.code||'WEB-AI-FAILED',error.message||'تعذر تشغيل Wareed AI.','فشل طلب التحليل للمستخدم '+String(session?.user?.username||''));throw error}
  }
  async function feedbackAi(payload){
    if(!canView('ai'))throw new Error('لا تملك صلاحية استخدام Wareed AI.');
    return request('webAiFeedback',{rating:String(payload?.rating||''),question:String(payload?.question||'').slice(0,600),answer:String(payload?.answer||'').slice(0,30000),correction:String(payload?.correction||'').slice(0,2000),asOf:String(payload?.asOf||'')});
  }
  function renderAiStatus(status){
    aiStatus=status||aiStatus||{configured:false,model:'gpt-6-astra'};const ready=aiStatus.configured===true,label=ready?'AI فعلي • '+aiStatus.model:'محرك حسابي • OpenAI غير مربوط';
    const badge=document.getElementById('wareedAiMode');if(badge){badge.textContent=label;badge.classList.toggle('warning',!ready)}const mini=document.getElementById('wareedAiMiniMode');if(mini)mini.textContent=label;
    const admin=document.getElementById('portalAiStatus');if(admin){admin.textContent=ready?'متصل وآمن بالخادم • '+aiStatus.model:'غير متصل بنموذج OpenAI — الإجابات الحالية حسابية محدودة';admin.className='pill '+(ready?'':'warning')}
    const model=document.getElementById('portalAiModel');if(model&&!model.dataset.touched)model.value=aiStatus.model||'gpt-6-astra';
  }
  async function loadAiStatus(){
    if(!canView('ai'))return null;try{const result=await request('webAiStatus',{});renderAiStatus(result);return result}catch(error){renderAiStatus({configured:false,model:'gpt-6-astra'});return null}
  }
  async function saveAiConfig(){
    if(session?.user?.role!=='owner')return;const key=document.getElementById('portalAiApiKey'),model=document.getElementById('portalAiModel'),message=document.getElementById('portalAiMessage'),button=document.getElementById('portalAiSave');const apiKey=String(key?.value||'').trim();if(!apiKey){message.textContent='أدخل مفتاح OpenAI API أولًا.';key?.focus();return}button.disabled=true;message.textContent='جارٍ التحقق من المفتاح والنموذج في الخادم...';
    try{const result=await request('webSaveAiConfig',{apiKey,model:model?.value||'gpt-6-astra'});if(key)key.value='';renderAiStatus(result);message.textContent='تم ربط Wareed AI بنجاح. الأسئلة الجديدة ستستخدم النموذج الفعلي مع أدوات تحليل بيانات وريد.'}catch(error){message.textContent=error.message||'تعذر ربط OpenAI.'}finally{button.disabled=false}
  }
  function applyPermissions(){
    document.querySelectorAll('.nav[data-page]').forEach(node=>{const page=node.dataset.page;node.hidden=page==='users'?session?.user?.role!=='owner':page==='areaAdmin'?!canAction('manageAreas'):!canView(page)});
    document.querySelectorAll('[data-owner-only]').forEach(node=>{if(node.matches('[data-page]'))return;node.hidden=session?.user?.role!=='owner'});
    const aiFab=document.getElementById('wareedAiFab');if(aiFab)aiFab.hidden=!canView('ai');if(!canView('ai'))window.openWareedAiMini?.(false);
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
  function activateSessionShell(user,statusText){
    if(!user)return;
    session.user=user;saveSession(session);installSessionHeader();ensureAreaShell();
    const name=document.getElementById('portalSessionName');if(name)name.textContent=user.username;
    applyPermissions();if(user.role==='owner'){if(!document.getElementById('portalUserFormTitle'))renderAdminShell();void loadUsers()}if(canView('ai'))void loadAiStatus();hideGate();
    const status=document.getElementById('sourceStatus');if(status&&statusText)status.textContent=statusText;
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
      if(name==='pageChanged'&&arg==='regions')renderRegions();
      if(name==='pageChanged'&&arg==='areaAdmin'&&canAction('manageAreas'))loadAreaGroups();
      if(name==='refreshReport'&&!canAction('refresh'))return window.toast('لا تملك صلاحية التحديث');
      if(name==='sendReport'&&!canAction('sendReport'))return window.toast('لا تملك صلاحية الإرسال');
      if(name==='requestArchive'&&!canAction('archive'))return window.toast('لا تملك صلاحية طلب الأرشيف');
      if(name==='exportReport'&&!canAction('download'))return window.toast('لا تملك صلاحية التنزيل');
      if(name==='manageCloud')return handleManageCloud(arg);
      if(name==='clearDiagnostics'){
        localStorage.removeItem(DIAGNOSTICS_KEY);
        window.applyLocalConfig?.({cloudEndpoint:CONFIG.endpoint,liveIntervalMinutes:1},{name:session?.user?.username||'',email:session?.user?.username||'',role:session?.user?.role||'user'},[]);
        return;
      }
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
      const result=await request('webBootstrap',{});session.user=result.user;areaPayload=result.area||null;saveSession(session);window.applyCloudBootstrap(result);window.applyLocalConfig({cloudEndpoint:CONFIG.endpoint,liveIntervalMinutes:1},{name:result.user.username,email:result.user.username,role:result.user.role},diagnostics());activateSessionShell(result.user);renderRegions();window.startPortableLive?.();if(!silent)window.toast('تم تحميل التقارير بنجاح');return result;
    }catch(err){
      const message=err.message||'تعذر الاتصال بخدمة Wareed.';
      if(!err.diagnosticRecorded)recordDiagnostic('error',err.code||'WEB-BOOTSTRAP-FAILED',message,'فشل تحميل بيانات الداشبورد بعد التحقق من الجلسة.');
      if(isSessionFailure(err)){
        saveSession(null);clearInterval(window.PORTABLE_LIVE_TIMER);showGate(message);
      }else if(document.body.classList.contains('portal-locked')){
        showGate(message+' الجلسة محفوظة؛ أعد تحميل الصفحة للمحاولة مرة أخرى.');
      }else{
        const status=document.getElementById('sourceStatus');if(status)status.textContent='تعذر التحديث: '+message+' — ستتم المحاولة تلقائيًا';
      }
      return null;
    }
  }
  function ensureAreaShell(){
    if(document.getElementById('regions'))return;
    const usersNav=document.querySelector('.nav[data-page="users"]'),drawer=document.getElementById('drawer');
    const regionsNav=document.createElement('button');regionsNav.className='nav';regionsNav.dataset.page='regions';regionsNav.textContent='المناطق';regionsNav.onclick=function(){window.go('regions',this)};
    (usersNav||drawer?.querySelector('.drawer-foot'))?.before(regionsNav);
    const adminNav=document.createElement('button');adminNav.className='nav';adminNav.dataset.page='areaAdmin';adminNav.textContent='إدارة مستخدمي المناطق';adminNav.onclick=function(){window.go('areaAdmin',this)};
    (usersNav||drawer?.querySelector('.drawer-foot'))?.before(adminNav);
    const main=document.querySelector('main.wrap'),settings=document.getElementById('settings');
    const regions=document.createElement('section');regions.id='regions';regions.className='page';regions.innerHTML='<div class="area-report-hero"><img src="wareed-logo.png" alt="مختبرات وريد الطبية"><div><span>تقرير أداء المناطق</span><h1 id="areaPageTitle">المناطق</h1><p id="areaPageUpdated">جارٍ تحميل أحدث بيانات الدخل والتارجت</p></div></div><div id="areaReports" class="area-reports"></div>';
    const admin=document.createElement('section');admin.id='areaAdmin';admin.className='page';admin.innerHTML='<div class="hero"><h1>إدارة مستخدمي المناطق</h1><p>أنشئ مجموعة ومديرًا وحدد الفروع التي تظهر له — بحد أقصى 30 فرعًا</p></div><div class="section"><div class="section-head"><h2 id="areaFormTitle">إضافة مجموعة منطقة</h2><button class="soft" type="button" onclick="WareedPortal.resetAreaForm()">مجموعة جديدة</button></div><input type="hidden" id="areaGroupId"><input type="hidden" id="areaUserId"><div class="portal-admin-grid"><label>عنوان الاجتماع<input id="areaMeetingTitle" placeholder="مثال: اجتماع منطقة الرياض"></label><label>اسم دخول مدير المنطقة<input id="areaUsername" dir="ltr" placeholder="username"></label><label>كلمة المرور<input id="areaPassword" type="password" dir="ltr" autocomplete="new-password" placeholder="مطلوبة للجديد"></label><label><span><input id="areaEnabled" type="checkbox" checked> المجموعة والحساب مفعلان</span></label><label class="full">بحث في الفروع<input id="areaBranchSearch" placeholder="اكتب اسم الفرع أو المدينة" oninput="WareedPortal.renderAreaCatalog()"></label></div><div class="area-branch-head"><b>الفروع المختارة</b><span id="areaSelectedCount" class="pill">0 / 30</span></div><div id="areaBranchCatalog" class="area-branch-catalog"><p class="subtle">جارٍ تحميل قائمة الفروع…</p></div><div class="portal-admin-actions"><button class="primary" type="button" onclick="WareedPortal.saveAreaGroup()">حفظ المجموعة والمستخدم</button><button class="soft" type="button" onclick="WareedPortal.resetAreaForm()">إلغاء</button></div><p id="areaAdminMessage" class="subtle"></p></div><div class="section"><div class="section-head"><h2>مجموعات المناطق</h2><span id="areaGroupsCount" class="pill">0</span></div><div id="areaGroupsList" class="area-admin-list"></div></div>';
    if(settings){main.insertBefore(regions,settings);main.insertBefore(admin,settings)}else{main.append(regions,admin)}
  }
  function money(value){return new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(Number(value||0))+' ر.س'}
  function rate(value){return new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(Number(value||0))+'%'}
  function renderRegions(){
    const host=document.getElementById('areaReports');if(!host)return;
    const groups=areaPayload?.groups||[];
    const updated=document.getElementById('areaPageUpdated');if(updated)updated.textContent='آخر تحديث: '+(areaPayload?.generatedAt?new Date(areaPayload.generatedAt).toLocaleString('ar-SA'):'—');
    const title=document.getElementById('areaPageTitle');if(title)title.textContent=groups.length===1&&!areaPayload?.canManage?groups[0].title:'أداء جميع المناطق';
    host.innerHTML=groups.map(group=>'<article class="area-report-card"><div class="area-report-title"><div><span>عنوان الاجتماع</span><h2>'+window.escapeHtml(group.title)+'</h2><small>'+(group.manager?'مدير المنطقة: '+window.escapeHtml(group.manager.username):'لم يُربط مدير')+'</small></div><span class="pill">'+group.branches.length+' فرع</span></div><div class="area-cities">'+group.branches.map(branch=>'<span>'+window.escapeHtml(branch.label||branch.branch)+'</span>').join('')+'</div><div class="area-metric-grid"><div><span>التارجت الشهري</span><b>'+money(group.metrics.monthTarget)+'</b></div><div><span>الدخل الشهري</span><b>'+money(group.metrics.monthIncome)+'</b><small>'+rate(group.metrics.monthRate)+'</small></div><div><span>التارجت اليومي</span><b>'+money(group.metrics.dailyTarget)+'</b></div><div><span>الدخل اليومي</span><b>'+money(group.metrics.dailyIncome)+'</b><small>'+rate(group.metrics.dailyRate)+'</small></div></div></article>').join('')||'<div class="section empty">لا توجد مجموعة منطقة مرتبطة بهذا الحساب بعد.</div>';
  }
  async function loadAreaGroups(){
    if(!canAction('manageAreas'))return [];
    const message=document.getElementById('areaAdminMessage');if(message)message.textContent='جارٍ تحميل المجموعات والفروع…';
    try{const result=await request('webListAreaGroups',{});areaGroups=result.groups||[];areaCatalog=result.catalog||[];renderAreaCatalog();renderAreaGroupsList();if(message)message.textContent='';return areaGroups}catch(error){if(message)message.textContent=error.message;return []}
  }
  function selectedAreaBranches(){return [...areaSelectedBranches]}
  function renderAreaCatalog(){
    const host=document.getElementById('areaBranchCatalog');if(!host)return;
    const query=String(document.getElementById('areaBranchSearch')?.value||'').toLowerCase();
    host.innerHTML=areaCatalog.filter(item=>!query||String(item.branch+' '+item.label+' '+item.city).toLowerCase().includes(query)).map(item=>'<label><input type="checkbox" name="areaBranch" value="'+window.escapeHtml(item.branch)+'" '+(areaSelectedBranches.has(item.branch)?'checked':'')+' onchange="WareedPortal.areaSelectionChanged(this)"><span><b>'+window.escapeHtml(item.label||item.branch)+'</b><small dir="ltr">'+window.escapeHtml(item.branch)+'</small></span></label>').join('')||'<p class="subtle">لا توجد نتائج.</p>';
    updateAreaSelectedCount();
  }
  function areaSelectionChanged(node){
    if(node.checked&&areaSelectedBranches.size>=30){node.checked=false;window.toast('الحد الأعلى 30 فرعًا لكل مستخدم منطقة')}else if(node.checked)areaSelectedBranches.add(node.value);else areaSelectedBranches.delete(node.value);updateAreaSelectedCount();
  }
  function updateAreaSelectedCount(){const node=document.getElementById('areaSelectedCount');if(node)node.textContent=selectedAreaBranches().length+' / 30'}
  function renderAreaGroupsList(){
    const host=document.getElementById('areaGroupsList');if(!host)return;document.getElementById('areaGroupsCount').textContent=areaGroups.length;
    host.innerHTML=areaGroups.map(group=>'<article><div><h3>'+window.escapeHtml(group.title)+'</h3><p>'+(group.manager?window.escapeHtml(group.manager.username):'بلا مستخدم')+' • '+group.branches.length+' فرع • '+(group.enabled?'مفعلة':'موقوفة')+'</p></div><div><button class="soft" onclick="WareedPortal.editAreaGroup(\''+window.escapeJs(group.id)+'\')">تعديل</button><button class="soft danger" onclick="WareedPortal.deleteAreaGroup(\''+window.escapeJs(group.id)+'\')">حذف</button></div></article>').join('')||'<p class="subtle">لا توجد مجموعات مناطق بعد.</p>';
  }
  function resetAreaForm(){
    ['areaGroupId','areaUserId','areaMeetingTitle','areaUsername','areaPassword','areaBranchSearch'].forEach(id=>{const node=document.getElementById(id);if(node)node.value=''});areaSelectedBranches=new Set();const enabled=document.getElementById('areaEnabled');if(enabled)enabled.checked=true;const title=document.getElementById('areaFormTitle');if(title)title.textContent='إضافة مجموعة منطقة';renderAreaCatalog();
  }
  function editAreaGroup(id){
    const group=areaGroups.find(item=>item.id===id);if(!group)return;document.getElementById('areaGroupId').value=group.id;document.getElementById('areaUserId').value=group.manager?.id||'';document.getElementById('areaMeetingTitle').value=group.title;document.getElementById('areaUsername').value=group.manager?.username||'';document.getElementById('areaPassword').value='';document.getElementById('areaEnabled').checked=group.enabled;document.getElementById('areaFormTitle').textContent='تعديل '+group.title;areaSelectedBranches=new Set(group.branches.map(branch=>branch.branch||branch));renderAreaCatalog();scrollTo({top:document.getElementById('areaAdmin').offsetTop,behavior:'smooth'});
  }
  async function saveAreaGroup(){
    const message=document.getElementById('areaAdminMessage');message.textContent='جارٍ حفظ المجموعة والمستخدم…';
    const group={id:document.getElementById('areaGroupId').value,title:document.getElementById('areaMeetingTitle').value.trim(),enabled:document.getElementById('areaEnabled').checked,branches:selectedAreaBranches()};
    const user={id:document.getElementById('areaUserId').value,username:document.getElementById('areaUsername').value.trim(),password:document.getElementById('areaPassword').value};
    try{await request('webUpsertAreaGroup',{group,user});message.textContent='تم حفظ المجموعة وحساب مدير المنطقة.';resetAreaForm();await loadAreaGroups();const refreshed=await request('webBootstrap',{});areaPayload=refreshed.area||areaPayload;renderRegions()}catch(error){message.textContent=error.message}
  }
  async function deleteAreaGroup(id){if(!confirm('حذف مجموعة المنطقة وتعطيل حساب مديرها؟'))return;try{await request('webDeleteAreaGroup',{groupId:id});window.toast('تم حذف المجموعة وتعطيل الحساب');await loadAreaGroups()}catch(error){window.toast(error.message)}}
  function renderAdminShell(){
    const section=document.getElementById('users');if(!section)return;
    section.innerHTML='<div class="hero"><h1>إدارة المستخدمين والصلاحيات</h1><p>هذه الصفحة خاصة بحساب المالك فقط</p></div><div class="section"><div class="section-head"><h2 id="portalUserFormTitle">إضافة مستخدم</h2><button class="soft" type="button" onclick="WareedPortal.resetUserForm()">مستخدم جديد</button></div><input type="hidden" id="portalUserId"><div class="portal-admin-grid"><label>اسم المستخدم<input id="portalUserName" name="portal_new_username" dir="ltr" autocomplete="off" data-lpignore="true" data-1p-ignore="true" readonly onfocus="this.removeAttribute(\'readonly\')" placeholder="username"></label><label>كلمة المرور<input id="portalUserPassword" name="portal_new_password" dir="ltr" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" readonly onfocus="this.removeAttribute(\'readonly\')" placeholder="مطلوبة للجديد، واتركها فارغة عند عدم التغيير"></label><label class="full"><span><input type="checkbox" id="portalUserEnabled" checked> الحساب مفعل</span></label></div><div class="portal-permission-groups"><div class="portal-permission-box"><h3>الصفحات التي يستطيع فتحها</h3><div class="portal-permission-list" id="portalViewPermissions"></div></div><div class="portal-permission-box"><h3>الإجراءات التي يستطيع تنفيذها</h3><div class="portal-permission-list" id="portalActionPermissions"></div></div></div><div class="portal-admin-actions"><button class="primary" type="button" onclick="WareedPortal.saveUser()">حفظ المستخدم والصلاحيات</button><button class="soft" type="button" onclick="WareedPortal.resetUserForm()">إلغاء التعديل</button></div><p class="subtle" id="portalUserMessage"></p></div><div class="section"><div class="section-head"><h2>المستخدمون</h2><span class="pill" id="portalUsersCount">0</span></div><div class="table-scroll"><table class="portal-users-table"><thead><tr><th>المستخدم</th><th>الحالة</th><th>الدور</th><th>الصفحات</th><th>الإجراءات</th><th>آخر دخول</th><th>التحكم</th></tr></thead><tbody id="portalUsersBody"></tbody></table></div></div>';
    section.insertAdjacentHTML('beforeend','<div class="section"><div class="section-head"><h2>إعداد Wareed AI الحقيقي</h2><span class="pill warning" id="portalAiStatus">جاري فحص المحرك</span></div><p class="subtle">المفتاح ينتقل مباشرة إلى Google Apps Script ويُحفظ في خصائص الخادم. لا يُحفظ في GitHub أو المتصفح ولا تتم إعادته للواجهة. يستخدم Wareed AI أدوات بحث داخلية للوصول إلى التاريخ المصرح به فقط.</p><div class="portal-admin-grid"><label>OpenAI API Key<input id="portalAiApiKey" name="portal_openai_key" dir="ltr" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" placeholder="sk-..."></label><label>النموذج<select id="portalAiModel" onchange="this.dataset.touched=\'1\'"><option value="gpt-6-astra">GPT-6 Astra — أعلى ذكاء</option><option value="gpt-5.6-terra">GPT-5.6 Terra — متوازن</option><option value="gpt-5.6-luna">GPT-5.6 Luna — أسرع وأوفر</option></select></label></div><div class="portal-admin-actions"><button id="portalAiSave" class="primary" type="button" onclick="WareedPortal.saveAiConfig()">تحقق واربط Wareed AI</button></div><p class="subtle" id="portalAiMessage">لن يظهر المفتاح بعد الحفظ.</p></div>');
    document.getElementById('portalViewPermissions').innerHTML=Object.entries(VIEW_LABELS).map(([key,label])=>'<label><input type="checkbox" name="portalView" value="'+key+'"> '+label+'</label>').join('');
    document.getElementById('portalActionPermissions').innerHTML=Object.entries(ACTION_LABELS).map(([key,label])=>'<label><input type="checkbox" name="portalAction" value="'+key+'"> '+label+'</label>').join('');
    section.querySelectorAll('#portalUserName,#portalUserPassword,#portalUserEnabled,[name=portalView],[name=portalAction]').forEach(node=>node.addEventListener('input',()=>{userFormTouched=true}));
    resetUserForm();renderAiStatus(aiStatus);
  }
  async function loadUsers(force=false){
    if(session?.user?.role!=='owner')return [];
    if(!force&&users.length&&Date.now()-usersLoadedAt<30000){renderUsers();return users}
    if(usersLoadPromise)return usersLoadPromise;
    const body=document.getElementById('portalUsersBody');if(body&&!users.length)body.innerHTML='<tr><td colspan="7">جارٍ تحميل المستخدمين والصلاحيات...</td></tr>';
    usersLoadPromise=(async()=>{
      try{const result=await request('webListUsers',{});users=result.users||[];usersLoadedAt=Date.now();renderUsers();return users}
      catch(err){
        if(!err.diagnosticRecorded)recordDiagnostic('error',err.code||'WEB-USERS-LOAD-FAILED',err.message||'تعذر تحميل المستخدمين.','تعذر قراءة قائمة المستخدمين والصلاحيات من BI Web Users.');
        const target=document.getElementById('portalUsersBody');if(target)target.innerHTML='<tr><td colspan="7">تعذر تحميل المستخدمين: '+window.escapeHtml(err.message||'خطأ غير معروف')+' <button class="soft" type="button" onclick="WareedPortal.loadUsers()">إعادة المحاولة</button></td></tr>';
        window.toast(err.message);return [];
      }finally{usersLoadPromise=null}
    })();
    return usersLoadPromise;
  }
  function renderUsers(){
    const body=document.getElementById('portalUsersBody');if(!body)return;
    document.getElementById('portalUsersCount').textContent=users.length;
    body.innerHTML=users.map(user=>'<tr class="'+(user.enabled?'':'portal-user-off')+'"><td><b dir="ltr">'+window.escapeHtml(user.username)+'</b></td><td>'+(user.enabled?'مفعل':'موقوف')+'</td><td><span class="portal-role '+user.role+'">'+(user.role==='owner'?'المالك':user.role==='area_manager'?'مدير منطقة':'مستخدم')+'</span></td><td>'+((user.permissions?.views||[]).length)+' صفحة</td><td>'+((user.permissions?.actions||[]).length)+' إجراء</td><td dir="ltr">'+(user.lastLoginAt?new Date(user.lastLoginAt).toLocaleString('ar-SA'):'—')+'</td><td><div class="portal-user-actions"><button class="soft" onclick="WareedPortal.editUser(\''+window.escapeJs(user.id)+'\')">تعديل</button>'+(user.role==='owner'?'':'<button class="soft danger" onclick="WareedPortal.deleteUser(\''+window.escapeJs(user.username)+'\')">حذف</button>')+'</div></td></tr>').join('')||'<tr><td colspan="7">لا يوجد مستخدمون</td></tr>';
  }
  function resetUserForm(){
    ['portalUserId','portalUserName','portalUserPassword'].forEach(id=>{const node=document.getElementById(id);if(node)node.value=''});const enabled=document.getElementById('portalUserEnabled');if(enabled)enabled.checked=true;document.querySelectorAll('[name=portalView],[name=portalAction]').forEach(node=>node.checked=false);const title=document.getElementById('portalUserFormTitle');if(title)title.textContent='إضافة مستخدم';userFormTouched=false;
  }
  function editUser(id){
    const user=users.find(item=>item.id===id);if(!user)return;document.getElementById('portalUserId').value=user.id;document.getElementById('portalUserName').value=user.username;document.getElementById('portalUserPassword').value='';document.getElementById('portalUserEnabled').checked=user.enabled;document.querySelectorAll('[name=portalView]').forEach(node=>node.checked=user.permissions?.views?.includes(node.value));document.querySelectorAll('[name=portalAction]').forEach(node=>node.checked=user.permissions?.actions?.includes(node.value));document.getElementById('portalUserFormTitle').textContent='تعديل '+user.username;userFormTouched=false;scrollTo({top:document.getElementById('users').offsetTop,behavior:'smooth'});
  }
  async function saveUser(){
    const message=document.getElementById('portalUserMessage');if(!userFormTouched){message.textContent='لم يتم إجراء أي تغيير.';return}message.textContent='جارٍ الحفظ...';
    const user={id:document.getElementById('portalUserId').value,username:document.getElementById('portalUserName').value.trim(),password:document.getElementById('portalUserPassword').value,enabled:document.getElementById('portalUserEnabled').checked,permissions:{views:[...document.querySelectorAll('[name=portalView]:checked')].map(node=>node.value),actions:[...document.querySelectorAll('[name=portalAction]:checked')].map(node=>node.value)}};
    try{const previousUsername=session.user.username;const result=await request('webUpsertUser',{user});document.getElementById('portalUserPassword').value='';if(result.user.id===session.user.id&&(user.password||result.user.username!==previousUsername)){saveSession(null);clearInterval(window.PORTABLE_LIVE_TIMER);showGate('تم تحديث حساب المالك. سجّل الدخول بالبيانات الجديدة.');return}message.textContent='تم حفظ '+result.user.username;resetUserForm();await loadUsers(true)}catch(err){message.textContent=err.message}
  }
  async function deleteUser(username){if(!confirm('حذف المستخدم '+username+' نهائيًا؟'))return;try{await request('webDeleteUser',{username});window.toast('تم حذف المستخدم');await loadUsers(true)}catch(err){window.toast(err.message)}}
  async function start(){
    injectGate();installHooks();session=readSession();
    if(session?.token&&(!session.expiresAt||Date.parse(session.expiresAt)>Date.now())){activateSessionShell(session.user,'جارٍ تحديث أحدث التقارير...');void loadBootstrap(true);return}
    if(session?.token)saveSession(null);
    showGate('');
  }
  window.WareedPortal={start,request,logout,loadUsers,renderUsers,editUser,deleteUser,saveUser,resetUserForm,permissions,canView,canAction,askAi,feedbackAi,loadAiStatus,saveAiConfig,loadAreaGroups,renderAreaCatalog,areaSelectionChanged,resetAreaForm,editAreaGroup,saveAreaGroup,deleteAreaGroup};
})();
