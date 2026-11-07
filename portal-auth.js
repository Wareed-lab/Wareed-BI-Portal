(function(){
  'use strict';
  const CONFIG=window.WAREED_PORTAL_CONFIG||{};
  const SESSION_KEY='wareedBiWebSessionV1';
  const DIAGNOSTICS_KEY='wareedDiagnostics';
  const DIAGNOSTICS_LIMIT=60;
  const VIEW_LABELS={home:'الرئيسية',executive:'التقرير التنفيذي',daily:'التقرير اليومي',salesComparison:'مركز المقارنات',ai:'Wareed AI',monthly:'التقرير الشهري',reservations:'تقرير الحجوزات',archive:'التقارير السابقة',send:'إرسال تقرير',recipients:'مستلمو التقارير',diagnostics:'التشخيص',settings:'الإعدادات',regions:'المناطق',ownerRegions:'حالة المناطق اليوم MTD'};
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
  let areaExpandedGroups=new Set();
  let areaLiveTimer=null;
  let areaRefreshRunning=false;

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
    try{if(session?.token)await request('webLogout',{})}catch(_){}saveSession(null);areaExpandedGroups.clear();clearInterval(window.PORTABLE_LIVE_TIMER);clearInterval(areaLiveTimer);showGate('تم تسجيل الخروج.');
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
    const areaManager=session?.user?.role==='area_manager';
    document.body.classList.toggle('area-manager-mode',areaManager);
    document.querySelectorAll('.nav[data-page]').forEach(node=>{const page=node.dataset.page;if(session?.user?.role==='area_manager'&&page!=='regions'){node.remove();return}node.hidden=page==='users'?session?.user?.role!=='owner':page==='areaAdmin'?!canAction('manageAreas'):!canView(page)});
    document.querySelectorAll('[data-owner-only]').forEach(node=>{if(node.matches('[data-page]'))return;node.hidden=session?.user?.role!=='owner'});
    const aiFab=document.getElementById('wareedAiFab');if(aiFab)aiFab.hidden=!canView('ai');if(!canView('ai'))window.openWareedAiMini?.(false);
    const refresh=document.querySelector('.top .icon[onclick*="refreshData"]');if(refresh)refresh.hidden=!canAction('refresh');
    if(areaManager){
      if(window.CURRENT_PAGE!=='regions')window.go('regions');
    }else if(!canView(window.CURRENT_PAGE||'home')){
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
      if(name==='pageChanged'&&arg==='ownerRegions'&&canView('ownerRegions'))renderOwnerRegions();
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
      const result=await request('webBootstrap',{});session.user=result.user;areaPayload=result.area||null;saveSession(session);window.applyCloudBootstrap(result);window.applyLocalConfig({cloudEndpoint:CONFIG.endpoint,liveIntervalMinutes:1},{name:result.user.username,email:result.user.username,role:result.user.role},diagnostics());activateSessionShell(result.user);renderRegions();renderOwnerRegions();if(canView('regions'))startAreaLive();else window.startPortableLive?.();if(!silent)window.toast('تم تحميل التقارير بنجاح');return result;
    }catch(err){
      const message=err.message||'تعذر الاتصال بخدمة Wareed.';
      if(!err.diagnosticRecorded)recordDiagnostic('error',err.code||'WEB-BOOTSTRAP-FAILED',message,'فشل تحميل بيانات الداشبورد بعد التحقق من الجلسة.');
      if(isSessionFailure(err)){
        saveSession(null);clearInterval(window.PORTABLE_LIVE_TIMER);clearInterval(areaLiveTimer);showGate(message);
      }else if(document.body.classList.contains('portal-locked')){
        showGate(message+' الجلسة محفوظة؛ أعد تحميل الصفحة للمحاولة مرة أخرى.');
      }else{
        const status=document.getElementById('sourceStatus');if(status)status.textContent='تعذر التحديث: '+message+' — ستتم المحاولة تلقائيًا';
      }
      return null;
    }
  }
  function ensureAreaShell(){
    const usersNav=document.querySelector('.nav[data-page="users"]'),drawer=document.getElementById('drawer');
    const main=document.querySelector('main.wrap'),settings=document.getElementById('settings');
    if(!document.getElementById('regions')){
      const regionsNav=document.createElement('button');regionsNav.className='nav';regionsNav.dataset.page='regions';regionsNav.textContent='المناطق';regionsNav.onclick=function(){window.go('regions',this)};
      (usersNav||drawer?.querySelector('.drawer-foot'))?.before(regionsNav);
      const adminNav=document.createElement('button');adminNav.className='nav';adminNav.dataset.page='areaAdmin';adminNav.textContent='إدارة مستخدمي المناطق';adminNav.onclick=function(){window.go('areaAdmin',this)};
      (usersNav||drawer?.querySelector('.drawer-foot'))?.before(adminNav);
      const regions=document.createElement('section');regions.id='regions';regions.className='page';regions.innerHTML='<div class="area-report-hero"><img src="wareed-logo.png" alt="مختبرات وريد الطبية"><div><span>تقرير أداء المناطق</span><h1 id="areaPageTitle">المناطق</h1><p id="areaPageUpdated">جارٍ تحميل أحدث بيانات الدخل والتارجت</p></div></div><div id="areaReports" class="area-reports"></div>';
      const admin=document.createElement('section');admin.id='areaAdmin';admin.className='page';admin.innerHTML='<div class="hero"><h1>إدارة مستخدمي المناطق</h1><p>أنشئ مجموعة ومديرًا وحدد الفروع التي تظهر له — بحد أقصى 30 فرعًا</p></div><div class="section"><div class="section-head"><h2 id="areaFormTitle">إضافة مجموعة منطقة</h2><button class="soft" type="button" onclick="WareedPortal.resetAreaForm()">مجموعة جديدة</button></div><input type="hidden" id="areaGroupId"><input type="hidden" id="areaUserId"><div class="portal-admin-grid"><label>اسم المنطقة<input id="areaMeetingTitle" placeholder="مثال: الرياض"></label><label>اسم دخول مدير المنطقة<input id="areaUsername" dir="ltr" placeholder="username"></label><label class="full">وصف الاجتماع<textarea id="areaMeetingDescription" rows="3" maxlength="500" placeholder="اكتب ملخص الاجتماع أو التوجيه المطلوب عرضه لمدير المنطقة"></textarea></label><label>كلمة المرور<input id="areaPassword" type="password" dir="ltr" autocomplete="new-password" placeholder="مطلوبة للجديد"></label><label><span><input id="areaEnabled" type="checkbox" checked> المجموعة والحساب مفعلان</span></label><label class="full">بحث في الفروع<input id="areaBranchSearch" placeholder="اكتب اسم الفرع أو المدينة" oninput="WareedPortal.renderAreaCatalog()"></label></div><div class="area-branch-head"><b>الفروع المختارة</b><span id="areaSelectedCount" class="pill">0 / 30</span></div><div id="areaBranchCatalog" class="area-branch-catalog"><p class="subtle">جارٍ تحميل قائمة الفروع…</p></div><div class="portal-admin-actions"><button class="primary" type="button" onclick="WareedPortal.saveAreaGroup()">حفظ المجموعة والمستخدم</button><button class="soft" type="button" onclick="WareedPortal.resetAreaForm()">إلغاء</button></div><p id="areaAdminMessage" class="subtle"></p></div><div class="section"><div class="section-head"><h2>مجموعات المناطق</h2><span id="areaGroupsCount" class="pill">0</span></div><div id="areaGroupsList" class="area-admin-list"></div></div>';
      if(settings){main.insertBefore(regions,settings);main.insertBefore(admin,settings)}else{main.append(regions,admin)}
    }
    ensureOwnerRegionsShell(usersNav,drawer,main,settings);
  }
  function ensureOwnerRegionsShell(usersNav,drawer,main,settings){
    const existingNav=document.querySelector('.nav[data-page="ownerRegions"]'),existingPage=document.getElementById('ownerRegions');
    if(!canView('ownerRegions')){existingNav?.remove();existingPage?.remove();return}
    if(existingPage)return;
    const nav=document.createElement('button');nav.className='nav owner-regions-nav';nav.dataset.page='ownerRegions';nav.textContent='MTD المناطق';nav.onclick=function(){window.go('ownerRegions',this)};
    const executiveNav=document.querySelector('.nav[data-page="executive"]');if(executiveNav?.parentNode)executiveNav.after(nav);else (usersNav||drawer?.querySelector('.drawer-foot'))?.before(nav);
    const page=document.createElement('section');page.id='ownerRegions';page.className='page owner-regions-page';page.innerHTML='<div class="owner-regions-hero"><div><span>حسب صلاحية المستخدم</span><h1>تحليل المدن والتجمعات</h1><p id="ownerRegionsUpdated">مقارنة كل مدينة بنفسها عبر مدد متساوية</p></div><label class="owner-header-date">تاريخ التقرير<input id="ownerRegionDate" type="date" onchange="WareedPortal.renderOwnerRegions()"></label><img src="wareed-logo.png" alt="مختبرات وريد الطبية"></div><div class="owner-region-controls"><label>المدينة / التجمع<select id="ownerRegionGroup" onchange="WareedPortal.renderOwnerRegions()"></select></label><label>مدة المقارنة<select id="ownerRegionPeriod" onchange="WareedPortal.renderOwnerRegions()"><option value="mtd">MTD حتى التاريخ المختار</option><option value="day">اليوم المختار مقابل اليوم السابق</option><option value="week">7 أيام حتى التاريخ مقابل 7 أيام قبلها</option><option value="fortnight">14 يومًا حتى التاريخ مقابل 14 يومًا قبلها</option></select></label><div class="owner-region-source"><b id="ownerRegionBasis">—</b><small id="ownerRegionRange">—</small></div></div><div id="ownerRegionKpis" class="owner-region-kpis"></div><div id="ownerCityProgress" class="owner-city-progress"></div><article class="owner-region-panel owner-regions-lines-panel"><div class="section-head"><div><h2>اتجاه المبيعات والتارجت يومًا بيوم</h2><p class="subtle">الفروع والزيارات المنزلية فقط — خط التارجت متقطع</p></div><span class="pill" id="ownerLinesMonth">—</span></div><div id="ownerRegionsLinesChart" class="owner-regions-lines-chart"></div><div id="ownerRegionsLinesDetails" class="owner-regions-lines-details"></div><div id="ownerRegionsLinesLegend" class="owner-regions-lines-legend"></div></article><div class="section owner-city-charts-section"><div class="section-head"><div><h2>مبيعات كل مدينة مقابل التارجت اليومي</h2><p class="subtle">أعمدة المبيعات اليومية مع خط التارجت المتقطع — رسم مستقل لكل مدينة</p></div><span class="pill" id="ownerCityChartsCount">0</span></div><div id="ownerCityDailyCharts" class="owner-city-daily-charts"></div></div><div class="owner-region-grid"><article class="owner-region-panel"><div class="section-head"><h2>المبيعات والتارجت خلال المدة</h2><span class="pill" id="ownerRegionChartLabel">—</span></div><div class="owner-region-legend"><span class="income">المبيعات</span><span class="target">تارجت المدة</span><span class="previous">المدة السابقة</span></div><div id="ownerRegionChart" class="owner-region-chart"></div></article><article class="owner-region-panel"><div class="section-head"><h2>المقارنة مع نفس المدينة</h2></div><div id="ownerRegionComparison" class="owner-region-comparison"></div></article></div><div class="owner-region-panel owner-region-ranking"><div class="section-head"><h2>ملخص جميع المدن والتجمعات</h2><span class="pill">حسب تحقيق MTD</span></div><div class="table-scroll"><table><thead><tr><th>المدينة / التجمع</th><th>الفروع</th><th>التارجت الشهري</th><th>المبيعات MTD</th><th>تحقيق MTD</th><th>المتبقي</th><th>المطلوب يوميًا</th><th>إيراد اليوم</th><th>ACC اليوم</th></tr></thead><tbody id="ownerRegionTable"></tbody></table></div></div><div class="section owner-city-reports-section"><div class="section-head"><div><h2>التقارير التفصيلية لكل مدينة</h2><p class="subtle">كل بطاقة محسوبة حتى التاريخ المختار</p></div><span class="pill" id="ownerCityCardsCount">0</span></div><div id="ownerCityCards" class="owner-city-cards"></div></div>';
    page.querySelector('.owner-regions-hero h1').textContent='حالة المناطق اليوم MTD';
    if(settings)main.insertBefore(page,settings);else main.append(page);
  }
  function ownerAreaSummary(rows){
    const data=Array.isArray(rows)?rows:[];const sum=field=>data.reduce((total,row)=>total+Math.max(0,Number(row?.[field])||0),0);const income=sum('income'),target=sum('target'),patients=sum('patients');
    return {income,target,patients,rate:target?income/target*100:0,average:patients?income/patients:0,gap:Math.max(0,target-income)};
  }
  function ownerPreviousMonthKey(monthKey){const parts=String(monthKey||'').split('-').map(Number),date=new Date(Date.UTC(parts[0]||2000,(parts[1]||1)-2,1));return date.toISOString().slice(0,7)}
  function ownerDaysInMonth(dateValue){const parts=String(dateValue||'').split('-').map(Number);return new Date(Date.UTC(parts[0]||2000,parts[1]||1,0)).getUTCDate()}
  function ownerCityMetricsAt(city,selectedDate,latestDate){
    const base=city?.current||{};if(!selectedDate||selectedDate===latestDate)return {...base};
    const monthKey=selectedDate.slice(0,7),elapsedDay=Number(selectedDate.slice(8,10))||1,daysInMonth=ownerDaysInMonth(selectedDate),month=(city?.monthly||[]).find(item=>item.monthKey===monthKey)||{},rows=(city?.daily||[]).filter(row=>String(row.date||'').slice(0,7)===monthKey&&String(row.date)<=selectedDate),dayRow=rows.find(row=>row.date===selectedDate)||{};
    const monthIncome=rows.reduce((sum,row)=>sum+(Number(row.income)||0),0),monthTarget=Math.max(0,Number(month.target)||((monthKey===String(latestDate||'').slice(0,7))?Number(base.monthTarget)||0:0)),mtdTarget=monthTarget/daysInMonth*elapsedDay,dailyTarget=Math.max(0,Number(dayRow.target)||monthTarget/daysInMonth),dailyIncome=Math.max(0,Number(dayRow.income)||0),patients=Math.max(0,Number(dayRow.patients)||0),remaining=Math.max(0,monthTarget-monthIncome),daysRemaining=Math.max(0,daysInMonth-elapsedDay);
    return {branchCount:Number(month.branchCount)||Number(base.branchCount)||0,monthIncome,monthTarget,monthRate:monthTarget?monthIncome/monthTarget*100:0,mtdTarget,mtdRate:mtdTarget?monthIncome/mtdTarget*100:0,remaining,requiredDaily:daysRemaining?remaining/daysRemaining:remaining,dailyIncome,dailyTarget,dailyRate:dailyTarget?dailyIncome/dailyTarget*100:0,patients,averageTicket:patients?dailyIncome/patients:0,elapsedDay,daysInMonth};
  }
  function ownerPeriodRows(daily,period){
    const rows=(Array.isArray(daily)?daily:[]).filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(String(row?.date||''))).sort((a,b)=>String(a.date).localeCompare(String(b.date)));if(!rows.length)return {current:[],previous:[],currentLabel:'لا توجد بيانات',previousLabel:'—'};
    const latest=String(rows[rows.length-1].date),dateLabel=list=>list.length?(list[0].date===list[list.length-1].date?list[0].date:list[0].date+' — '+list[list.length-1].date):'غير متوفر';let current=[],previous=[];
    if(period==='day'){current=rows.slice(-1);previous=rows.slice(-2,-1)}
    else if(period==='week'){current=rows.slice(-7);previous=rows.slice(-14,-7)}
    else if(period==='fortnight'){current=rows.slice(-14);previous=rows.slice(-28,-14)}
    else{const monthKey=latest.slice(0,7),day=Number(latest.slice(8,10)),previousKey=ownerPreviousMonthKey(monthKey);current=rows.filter(row=>String(row.date).slice(0,7)===monthKey&&Number(String(row.date).slice(8,10))<=day);previous=rows.filter(row=>String(row.date).slice(0,7)===previousKey&&Number(String(row.date).slice(8,10))<=day)}
    return {current,previous,currentLabel:dateLabel(current),previousLabel:dateLabel(previous)};
  }
  function ownerChange(current,previous){if(!Number.isFinite(previous)||previous===0)return null;return (current-previous)/previous*100}
  function ownerChangeHtml(value,suffix='%'){
    if(value===null||!Number.isFinite(value))return '<b>—</b><small>لا توجد مدة سابقة مكتملة</small>';const positive=value>=0;return '<b class="'+(positive?'positive':'negative')+'">'+(positive?'↑ ':'↓ ')+rate(Math.abs(value))+'</b><small>'+(positive?'تحسن':'انخفاض')+' عن المدة السابقة'+(suffix==='نقطة'?' (نقطة مئوية)':'')+'</small>';
  }
  function renderOwnerRegionChart(periodRows){
    const host=document.getElementById('ownerRegionChart');if(!host)return;const current=periodRows.current,previous=periodRows.previous,max=Math.max(1,...current.flatMap(row=>[Number(row.income)||0,Number(row.target)||0]),...previous.map(row=>Number(row.income)||0));
    host.innerHTML=current.map((row,index)=>{const prior=previous[index]||{},height=value=>Math.max(2,Math.round((Number(value)||0)/max*150));return '<div class="owner-region-chart-day"><div class="owner-region-chart-bars"><i class="income" style="height:'+height(row.income)+'px" title="مبيعات '+money(row.income)+'"></i><i class="target" style="height:'+height(row.target)+'px" title="تارجت '+money(row.target)+'"></i><i class="previous" style="height:'+height(prior.income)+'px" title="الفترة السابقة '+money(prior.income)+'"></i></div><b>'+window.escapeHtml(String(row.date).slice(5))+'</b><small>'+money(row.income).replace(' ر.س','')+'</small></div>'}).join('')||'<p class="subtle">لا توجد بيانات تاريخية لهذه المنطقة.</p>';
  }
  function ownerAllCities(cities,dailyBreakdown,selectedDate){
    const sum=field=>cities.reduce((total,city)=>total+Math.max(0,Number(city?.current?.[field])||0),0),dailyByDate=new Map();
    cities.forEach(city=>(city.daily||[]).forEach(row=>{const item=dailyByDate.get(row.date)||{date:row.date,capturedAt:row.capturedAt||'',income:0,target:0,patients:0};item.income+=Number(row.income)||0;item.target+=Number(row.target)||0;item.patients+=Number(row.patients)||0;dailyByDate.set(row.date,item)}));
    const liveRow=(dailyBreakdown||[]).find(row=>String(row?.date||'')===String(selectedDate||''))?.total||{},monthIncome=sum('monthIncome'),monthTarget=sum('monthTarget'),mtdTarget=sum('mtdTarget'),mappedDailyIncome=sum('dailyIncome'),mappedPatients=sum('patients'),dailyIncome=Number.isFinite(Number(liveRow.income))?Math.max(0,Number(liveRow.income)):mappedDailyIncome,dailyTarget=sum('dailyTarget'),patients=Number.isFinite(Number(liveRow.patients))?Math.max(0,Number(liveRow.patients)):mappedPatients,remaining=Math.max(0,monthTarget-monthIncome);return {id:'__all__',title:'جميع المناطق',daily:[...dailyByDate.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date))),monthly:[],current:{branchCount:sum('branchCount'),monthIncome,monthTarget,monthRate:monthTarget?monthIncome/monthTarget*100:0,mtdTarget,mtdRate:mtdTarget?monthIncome/mtdTarget*100:0,remaining,requiredDaily:sum('requiredDaily'),dailyIncome,dailyTarget,dailyRate:dailyTarget?dailyIncome/dailyTarget*100:0,patients,averageTicket:patients?dailyIncome/patients:0,elapsedDay:Math.max(...cities.map(city=>Number(city?.current?.elapsedDay)||0)),daysInMonth:Math.max(...cities.map(city=>Number(city?.current?.daysInMonth)||0))}};
  }
  function ownerChartColors(){return ['#36b5c5','#5d2469','#f0b928','#1b73b9','#dd624f','#168060','#8b64a6','#ef8f2f','#2f96a8','#9c4551','#4a6fa5','#78a94e','#c6508a','#5d7580','#7b5d28','#3d8f82']}
  function ownerLinePoint(value,max,index,count,width,height,pad){const x=pad+(count<=1?0:index*(width-pad*2)/(count-1)),y=height-pad-(Math.max(0,Number(value)||0)/Math.max(1,max))*(height-pad*2);return [x,y]}
  function renderOwnerRegionsLines(analytics,cities,selectedDate){
    const host=document.getElementById('ownerRegionsLinesChart'),legend=document.getElementById('ownerRegionsLinesLegend'),details=document.getElementById('ownerRegionsLinesDetails'),label=document.getElementById('ownerLinesMonth');if(!host||!legend)return;const monthKey=String(selectedDate||'').slice(0,7),breakdown=(analytics?.dailyBreakdown||[]).filter(row=>String(row.date||'').slice(0,7)===monthKey&&String(row.date)<=selectedDate).sort((a,b)=>String(a.date).localeCompare(String(b.date))),dates=breakdown.map(row=>row.date);if(label)label.textContent=monthKey||'—';
    if(!dates.length){host.innerHTML='<p class="subtle">لا توجد بيانات مصنفة للفروع والزيارات المنزلية في الفترة المختارة.</p>';legend.innerHTML='';if(details)details.innerHTML='';return}
    const series=[{title:'تارجت الفروع',color:'#5d2469',dashed:true,values:breakdown.map(row=>Number(row.branches?.target)||0)},{title:'تارجت الزيارات المنزلية',color:'#e2a411',dashed:true,values:breakdown.map(row=>Number(row.homeVisits?.target)||0)},{title:'مبيعات الفروع',color:'#5d2469',values:breakdown.map(row=>Number(row.branches?.income)||0)},{title:'مبيعات الزيارات المنزلية',color:'#f0b928',values:breakdown.map(row=>Number(row.homeVisits?.income)||0)}],averageValues=breakdown.map(row=>{const income=(Number(row.branches?.income)||0)+(Number(row.homeVisits?.income)||0),patients=(Number(row.branches?.patients)||0)+(Number(row.homeVisits?.patients)||0);return patients?income/patients:0}),max=Math.max(1,...series.flatMap(item=>item.values)),averageMax=Math.max(1,...averageValues),width=Math.max(1200,dates.length*110),height=390,pad=62,grid=[0,.25,.5,.75,1];
    const gridSvg=grid.map(step=>{const y=height-pad-step*(height-pad*2);return '<line x1="'+pad+'" x2="'+(width-pad)+'" y1="'+y+'" y2="'+y+'"/><text x="8" y="'+(y+4)+'">'+Math.round(max*step/1000)+'K</text>'}).join(''),xLabels=dates.map((date,index)=>{const p=ownerLinePoint(0,max,index,dates.length,width,height,pad);return '<text class="x-label" x="'+p[0]+'" y="'+(height-15)+'">'+date.slice(8,10)+'</text>'}).join(''),pointsFor=item=>item.values.map((value,index)=>ownerLinePoint(value,max,index,dates.length,width,height,pad)),salesSeries=series.filter(item=>!item.dashed),salesPoints=salesSeries.map(item=>pointsFor(item)),averageBarWidth=Math.max(28,Math.min(56,(width-pad*2)/Math.max(1,dates.length)*.32)),averageBars=averageValues.map((value,index)=>{const linePoint=ownerLinePoint(0,max,index,dates.length,width,height,pad),x=Math.max(4,Math.min(width-averageBarWidth-4,linePoint[0]-averageBarWidth/2)),y=height-pad-(value/averageMax)*(height-pad*2),barHeight=height-pad-y,collision=salesPoints.some(points=>Math.abs((points[index]?.[1]||0)-13-(y-10))<24),labelX=collision?(index<dates.length/2?x+averageBarWidth+7:x-7):x+averageBarWidth/2,labelAnchor=collision?(index<dates.length/2?'start':'end'):'middle',labelY=Math.max(20,y-10),income=(Number(breakdown[index].branches?.income)||0)+(Number(breakdown[index].homeVisits?.income)||0),patients=(Number(breakdown[index].branches?.patients)||0)+(Number(breakdown[index].homeVisits?.patients)||0);return '<g class="average-ticket-column"><rect x="'+x+'" y="'+y+'" width="'+averageBarWidth+'" height="'+barHeight+'"><title>'+dates[index]+' • متوسط الفاتورة '+money(value)+' • دخل '+money(income)+' ÷ ACC '+patients+'</title></rect><text x="'+labelX+'" y="'+labelY+'" text-anchor="'+labelAnchor+'">'+new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(value)+' ر.س</text></g>'}).join(''),lines=series.map(item=>{const points=pointsFor(item),poly=points.map(point=>point.join(',')).join(' '),dots=item.dashed?'':points.map((point,index)=>'<circle cx="'+point[0]+'" cy="'+point[1]+'" r="5"><title>'+window.escapeHtml(item.title)+' • '+dates[index]+' • '+money(item.values[index])+'</title></circle>').join('');return '<g class="city-line '+(item.dashed?'target-series':'sales-series')+'" style="color:'+item.color+'"><polyline points="'+poly+'"/>'+dots+'</g>'}).join(''),valueLabels=salesSeries.map(item=>pointsFor(item).map((point,index)=>'<text class="point-value" x="'+point[0]+'" y="'+Math.max(18,point[1]-13)+'">'+new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(item.values[index])+'</text>').join('')).join('');
    host.innerHTML='<svg viewBox="0 0 '+width+' '+height+'" width="100%" role="img" aria-label="مبيعات وتارجت الفروع والزيارات المنزلية ومتوسط الفاتورة اليومي"><g class="chart-grid">'+gridSvg+xLabels+'</g><g class="average-ticket-bars">'+averageBars+'</g>'+lines+'<g class="point-values">'+valueLabels+'</g></svg>';legend.innerHTML=series.map(item=>'<span class="'+(item.dashed?'target':'sales')+'"><i style="--series-color:'+item.color+'"></i>'+window.escapeHtml(item.title)+'</span>').join('')+'<span class="average"><i></i>متوسط الفاتورة اليومي</span>';
    if(details)details.innerHTML=breakdown.map(row=>{const branchIncome=Number(row.branches?.income)||0,branchPatients=Number(row.branches?.patients)||0,homeIncome=Number(row.homeVisits?.income)||0,homePatients=Number(row.homeVisits?.patients)||0,totalIncome=branchIncome+homeIncome,totalPatients=branchPatients+homePatients,totalAverage=totalPatients?totalIncome/totalPatients:0;return '<details><summary><b>ⓘ</b> '+String(row.date).slice(8,10)+'</summary><div><p class="total"><strong>الإجمالي المطابق للبطاقة</strong><span>المبيعات '+money(totalIncome)+'</span><span>ACC '+totalPatients+'</span><span>متوسط الفاتورة '+money(totalAverage)+'</span></p><p><strong>الفروع</strong><span>المبيعات '+money(branchIncome)+'</span><span>ACC '+branchPatients+'</span><span>متوسط الفاتورة '+money(branchPatients?branchIncome/branchPatients:0)+'</span></p><p><strong>الزيارات المنزلية</strong><span>المبيعات '+money(homeIncome)+'</span><span>ACC '+homePatients+'</span><span>متوسط الفاتورة '+money(homePatients?homeIncome/homePatients:0)+'</span></p></div></details>'}).join('');
  }
  function renderOwnerCityDailyCharts(cities,selectedDate){
    const host=document.getElementById('ownerCityDailyCharts'),count=document.getElementById('ownerCityChartsCount');if(!host)return;const monthKey=String(selectedDate||'').slice(0,7),colors=ownerChartColors();if(count)count.textContent=cities.length+' مدينة / تجمع';
    host.innerHTML=cities.map((city,cityIndex)=>{const rows=(city.daily||[]).filter(row=>String(row.date||'').slice(0,7)===monthKey&&String(row.date)<=selectedDate).sort((a,b)=>String(a.date).localeCompare(String(b.date))),metrics=city.current||{};if(!rows.length)return '<article class="owner-city-daily-card"><header><h3>'+window.escapeHtml(city.title)+'</h3><small>'+monthKey+'</small></header><p class="subtle">لا توجد بيانات يومية.</p></article>';const width=Math.max(1100,rows.length*74),height=320,pad=50,max=Math.max(1,...rows.flatMap(row=>[Number(row.income)||0,Number(row.target)||0])),plotW=width-pad*2,barW=Math.max(18,Math.min(38,plotW/rows.length*.56)),points=[];const bars=rows.map((row,index)=>{const value=Number(row.income)||0,x=pad+(index+.5)*plotW/rows.length,y=height-pad-value/max*(height-pad*2),h=height-pad-y,targetY=height-pad-(Number(row.target)||0)/max*(height-pad*2),valueLabel=new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(value);points.push(x+','+targetY);return '<rect x="'+(x-barW/2)+'" y="'+y+'" width="'+barW+'" height="'+h+'"><title>'+row.date+' • مبيعات '+money(row.income)+'</title></rect><text class="value-label" x="'+x+'" y="'+Math.max(18,y-9)+'">'+valueLabel+'</text><text class="day-label" x="'+x+'" y="'+(height-15)+'">'+String(row.date).slice(8,10)+'</text>'}).join(''),dailyTarget=Number(metrics.dailyTarget)||Number(rows[rows.length-1]?.target)||0,targetLabelY=height-pad-dailyTarget/max*(height-pad*2),targetLabel='التارجت اليومي: '+new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(dailyTarget)+' ر.س',mtdDifference=(Number(metrics.monthIncome)||0)-(Number(metrics.mtdTarget)||0),gapLabel=mtdDifference>=0?'متجاوز MTD ':'فجوة MTD ';return '<article class="owner-city-daily-card"><header><div><h3>'+window.escapeHtml(city.title)+'</h3><small>'+monthKey+' • حتى '+selectedDate+'</small></div><b>'+rate(metrics.mtdRate)+'</b></header><div class="owner-city-chart-summary"><span>المبيعات '+money(metrics.monthIncome)+'</span><span>تارجت MTD '+money(metrics.mtdTarget)+'</span><span class="gap '+(mtdDifference>=0?'positive':'negative')+'">'+gapLabel+money(Math.abs(mtdDifference))+'</span></div><div class="owner-city-mini-chart"><svg viewBox="0 0 '+width+' '+height+'" width="'+width+'" height="'+height+'"><polyline class="target-line" points="'+points.join(' ')+'"/><text class="target-value-label" x="'+(pad+8)+'" y="'+Math.max(22,targetLabelY-12)+'">'+targetLabel+'</text><g class="bars" style="color:'+colors[cityIndex%colors.length]+'">'+bars+'</g></svg></div><div class="owner-city-mini-legend"><span class="sales">المبيعات اليومية</span><span class="target">التارجت اليومي</span></div></article>'}).join('');
  }
  function renderOwnerRegions(){
    const page=document.getElementById('ownerRegions');if(!page||!canView('ownerRegions'))return;const analytics=areaPayload?.ownerCityAnalytics,cities=analytics?.cities||[],select=document.getElementById('ownerRegionGroup'),period=document.getElementById('ownerRegionPeriod')?.value||'mtd',dateInput=document.getElementById('ownerRegionDate');
    if(!cities.length){document.getElementById('ownerRegionKpis').innerHTML='<div class="section empty">جارٍ تجهيز سجل المدن والتجمعات. حدّث الصفحة بعد نشر خدمة البيانات.</div>';['ownerRegionChart','ownerRegionComparison','ownerRegionTable','ownerCityCards','ownerRegionsLinesChart','ownerRegionsLinesDetails','ownerRegionsLinesLegend','ownerCityDailyCharts'].forEach(id=>{const node=document.getElementById(id);if(node)node.innerHTML=''});return}
    const allDates=cities.flatMap(city=>(city.daily||[]).map(row=>String(row.date||'')).filter(value=>/^\d{4}-\d{2}-\d{2}$/.test(value))).sort(),availableFrom=analytics.availableFrom||allDates[0]||analytics.latestDate,availableTo=analytics.availableTo||analytics.latestDate||allDates[allDates.length-1],latestDate=analytics.latestDate||availableTo;let selectedDate=dateInput?.value||latestDate;if(selectedDate>availableTo)selectedDate=availableTo;if(selectedDate<availableFrom)selectedDate=availableFrom;if(dateInput){dateInput.min=availableFrom;dateInput.max=availableTo;dateInput.value=selectedDate}
    const scopedCities=cities.map(city=>({...city,current:ownerCityMetricsAt(city,selectedDate,latestDate)})),cityOptions=[ownerAllCities(scopedCities,analytics.dailyBreakdown,selectedDate),...scopedCities],selected=select?.value&&cityOptions.some(city=>city.id===select.value)?select.value:'__all__';if(select){select.innerHTML=cityOptions.map(city=>'<option value="'+window.escapeHtml(city.id)+'" '+(city.id===selected?'selected':'')+'>'+window.escapeHtml(city.title)+'</option>').join('')}
    const city=cityOptions.find(item=>item.id===selected)||cityOptions[0],metrics=city.current||{},eligibleDaily=(city.daily||[]).filter(row=>String(row.date||'')<=selectedDate),ranges=ownerPeriodRows(eligibleDaily,period),current=ownerAreaSummary(ranges.current),previous=ownerAreaSummary(ranges.previous),incomeChange=ownerChange(current.income,previous.income),patientsChange=ownerChange(current.patients,previous.patients),averageChange=ownerChange(current.average,previous.average),rateDelta=ranges.previous.length?current.rate-previous.rate:null;
    document.getElementById('ownerRegionsUpdated').textContent='تاريخ التقرير: '+selectedDate+' • آخر تحديث للبيانات: '+areaUpdateStamp(areaPayload?.generatedAt);document.getElementById('ownerRegionBasis').textContent='مصدر التارجت: '+(analytics.targetBasis||'Fahad & Reem Target');document.getElementById('ownerRegionRange').textContent='الحالية: '+ranges.currentLabel+' • السابقة: '+ranges.previousLabel;document.getElementById('ownerRegionChartLabel').textContent=city.title;
    document.getElementById('ownerRegionKpis').innerHTML='<article><span>التارجت الشهري</span><b>'+money(metrics.monthTarget)+'</b><small>'+money(metrics.dailyTarget)+' يوميًا</small></article><article><span>المبيعات MTD</span><b>'+money(metrics.monthIncome)+'</b><small>من بداية الشهر حتى اليوم '+metrics.elapsedDay+'</small></article><article><span>تارجت MTD</span><b>'+money(metrics.mtdTarget)+'</b><small>التارجت الشهري ÷ '+metrics.daysInMonth+' × '+metrics.elapsedDay+'</small></article><article><span>تحقيق MTD</span><b>'+rate(metrics.mtdRate)+'</b><small>تحقيق الشهر الكامل '+rate(metrics.monthRate)+'</small></article><article><span>المتبقي للشهر</span><b>'+money(metrics.remaining)+'</b><small>حتى الوصول إلى 100%</small></article><article><span>المطلوب يوميًا للإغلاق</span><b>'+money(metrics.requiredDaily)+'</b><small>على الأيام المتبقية من الشهر</small></article><article><span>أداء اليوم</span><b>'+money(metrics.dailyIncome)+'</b><small>من '+money(metrics.dailyTarget)+' • '+rate(metrics.dailyRate)+'</small></article><article><span>العملاء ومتوسط الفاتورة</span><b>'+money(metrics.patients).replace(' ر.س','')+' عميل</b><small>متوسط '+money(metrics.averageTicket)+'</small></article>';
    const progress=Math.max(0,Math.min(100,Number(metrics.mtdRate)||0));document.getElementById('ownerCityProgress').innerHTML='<div><span><b>'+window.escapeHtml(city.title)+'</b><small>'+Number(metrics.branchCount||0)+' فرع • حتى '+selectedDate+'</small></span><strong>'+rate(metrics.mtdRate)+' من تارجت MTD</strong></div><div class="owner-city-progress-track"><i style="width:'+progress+'%"></i></div><p>وصلت المبيعات إلى <b>'+money(metrics.monthIncome)+'</b> من تارجت MTD <b>'+money(metrics.mtdTarget)+'</b>، والمتبقي على تارجت الشهر الكامل <b>'+money(metrics.remaining)+'</b>.</p>';
    document.getElementById('ownerRegionComparison').innerHTML='<div><span>تغير المبيعات</span>'+ownerChangeHtml(incomeChange)+'</div><div><span>تغير عدد العملاء</span>'+ownerChangeHtml(patientsChange)+'</div><div><span>تغير متوسط الفاتورة</span>'+ownerChangeHtml(averageChange)+'</div><div><span>تغير نسبة التحقيق</span>'+ownerChangeHtml(rateDelta,'نقطة')+'</div>';
    renderOwnerRegionChart(ranges);
    renderOwnerRegionsLines(analytics,scopedCities,selectedDate);renderOwnerCityDailyCharts(scopedCities,selectedDate);
    const ranked=scopedCities.slice().sort((a,b)=>Number(b.current?.mtdRate||0)-Number(a.current?.mtdRate||0));
    document.getElementById('ownerRegionTable').innerHTML=ranked.map(item=>{const row=item.current||{},hasTarget=Number(row.monthTarget)>0;return '<tr><td><b>'+window.escapeHtml(item.title)+'</b></td><td>'+Number(row.branchCount||0)+'</td><td>'+money(row.monthTarget)+'</td><td>'+money(row.monthIncome)+'</td><td><span class="owner-rate '+(!hasTarget?'neutral':row.mtdRate>=100?'good':row.mtdRate>=80?'watch':'risk')+'">'+(hasTarget?rate(row.mtdRate):'بلا تارجت')+'</span></td><td>'+money(row.remaining)+'</td><td>'+(hasTarget?money(row.requiredDaily):'—')+'</td><td>'+money(row.dailyIncome)+'</td><td>'+Number(row.patients||0)+'</td></tr>'}).join('');
    const cards=document.getElementById('ownerCityCards');document.getElementById('ownerCityCardsCount').textContent=scopedCities.length;cards.innerHTML=ranked.map(item=>{const row=item.current||{},hasTarget=Number(row.monthTarget)>0,state=!hasTarget?'بدون تارجت':row.mtdRate>=100?'متجاوز':row.mtdRate>=80?'قريب':'يحتاج تدخل',stateClass=!hasTarget?'neutral':row.mtdRate>=100?'good':row.mtdRate>=80?'watch':'risk';return '<article class="owner-city-card '+stateClass+'"><header><div><span>'+state+'</span><h3>'+window.escapeHtml(item.title)+'</h3><small>'+Number(row.branchCount||0)+' فرع • تاريخ التقرير '+selectedDate+'</small></div><b>'+(hasTarget?rate(row.mtdRate):'—')+'</b></header><div class="owner-city-card-grid"><p><span>التارجت الشهري</span><b>'+money(row.monthTarget)+'</b></p><p><span>المبيعات MTD</span><b>'+money(row.monthIncome)+'</b></p><p><span>تارجت MTD</span><b>'+money(row.mtdTarget)+'</b></p><p><span>المتبقي</span><b>'+money(row.remaining)+'</b></p><p><span>المطلوب يوميًا</span><b>'+(hasTarget?money(row.requiredDaily):'—')+'</b></p><p><span>اليوم</span><b>'+money(row.dailyIncome)+' / '+money(row.dailyTarget)+'</b></p><p><span>ACC اليوم</span><b>'+Number(row.patients||0)+'</b></p><p><span>متوسط الفاتورة</span><b>'+money(row.averageTicket)+'</b></p></div></article>'}).join('');
  }
  function money(value){return new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(Number(value||0))+' ر.س'}
  function rate(value){return new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(Number(value||0))+'%'}
  function areaUpdateStamp(value){
    if(!value)return '—';
    const date=new Date(value);if(Number.isNaN(date.getTime()))return String(value);
    try{return new Intl.DateTimeFormat('ar-SA-u-nu-latn',{timeZone:'Asia/Riyadh',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(date)}catch(_){return date.toLocaleString('ar-SA')}
  }
  function areaRefreshIcon(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-14.9-4.3L3 9m0 0V4m0 5h5M4 13a8.1 8.1 0 0 0 14.9 4.3L21 15m0 0v5m0-5h-5"/></svg><span>تحديث</span>'}
  function areaPayloadSignal(payload){return (payload?.groups||[]).reduce((sum,group)=>sum+Math.max(0,Number(group?.metrics?.monthTarget)||0)+Math.max(0,Number(group?.metrics?.monthIncome)||0),0)}
  function areaPayloadIsComplete(next,previous){if(!next||!Array.isArray(next.groups))return false;const oldSignal=areaPayloadSignal(previous),newSignal=areaPayloadSignal(next);return !(oldSignal>0&&newSignal<=0)}
  function renderRegions(){
    const host=document.getElementById('areaReports');if(!host)return;
    const groups=areaPayload?.groups||[];
    const updated=document.getElementById('areaPageUpdated');if(updated)updated.textContent='آخر تحديث: '+(areaPayload?.generatedAt?new Date(areaPayload.generatedAt).toLocaleString('ar-SA'):'—');
    const title=document.getElementById('areaPageTitle');if(title)title.textContent=groups.length===1&&!areaPayload?.canManage?groups[0].title:'أداء جميع المناطق';
    const isAreaManager=session?.user?.role==='area_manager';
    host.classList.toggle('area-manager-reports',isAreaManager);
    host.innerHTML=groups.map(group=>{
      const cities=[...new Set(group.branches.map(branch=>String(branch.city||branch.label||branch.branch||'').trim()).filter(Boolean))];
      const expanded=areaExpandedGroups.has(group.id),branchButtonLabel=expanded?'إخفاء الفروع':'عرض الفروع';
      const actions=isAreaManager?'<div class="area-screen-actions"><button class="area-screen-logout" type="button" onclick="WareedPortal.logout()">تسجيل الخروج</button><button class="area-screen-branches-toggle" type="button" onclick="WareedPortal.toggleAreaBranches(this)">'+branchButtonLabel+'</button></div>':'<div class="area-screen-actions"><button class="area-screen-branches-toggle" type="button" onclick="WareedPortal.toggleAreaBranches(this)">'+branchButtonLabel+'</button><small>'+(group.manager?'مدير المنطقة: '+window.escapeHtml(group.manager.username):'لم يُربط مدير')+'</small></div>';
      const brand='<div class="area-screen-brand"><img src="wareed-logo.png" alt="مختبرات وريد الطبية"><small>آخر تحديث: <time datetime="'+window.escapeHtml(areaPayload?.generatedAt||'')+'">'+window.escapeHtml(areaUpdateStamp(areaPayload?.generatedAt))+'</time></small></div>';
      const refresh='<button class="area-screen-refresh'+(areaRefreshRunning?' is-loading':'')+'" type="button" onclick="WareedPortal.refreshAreaDashboard(false)" aria-label="تحديث بيانات المنطقة الآن" title="تحديث بيانات المنطقة الآن" '+(areaRefreshRunning?'disabled':'')+'>'+areaRefreshIcon()+'</button>';
      const reportHead='<div class="area-screen-head">'+brand+refresh+'<div class="area-meeting-label">اجتماع المنطقة</div>'+actions+'</div>';
      const meetingTitle='<h1 class="area-screen-title">'+window.escapeHtml(group.title)+'</h1><p class="area-screen-description">'+window.escapeHtml(group.description||'')+'</p><div class="area-screen-branches" data-area-id="'+window.escapeHtml(group.id)+'" '+(expanded?'':'hidden')+'>'+cities.map(city=>'<span>'+window.escapeHtml(city)+'</span>').join('')+'</div>';
      return '<article class="area-report-card area-meeting-card '+(isAreaManager?'area-manager-card':'area-admin-meeting-card')+'" data-area-id="'+window.escapeHtml(group.id)+'">'+reportHead+meetingTitle+'<div class="area-metric-grid"><div><span>التارجت الشهري</span><b>'+money(group.metrics.monthTarget)+'</b></div><div><span>تحقيق الشهر</span><b>'+money(group.metrics.monthIncome)+'</b><small>'+rate(group.metrics.monthRate)+'</small></div><div><span>التارجت اليومي</span><b>'+money(group.metrics.dailyTarget)+'</b></div><div><span>تحقيق اليوم</span><b>'+money(group.metrics.dailyIncome)+'</b><small>'+rate(group.metrics.dailyRate)+'</small></div></div></article>';
    }).join('')||'<div class="section empty">لا توجد مجموعة منطقة مرتبطة بهذا الحساب بعد.</div>';
  }
  function toggleAreaBranches(button){
    const card=button?.closest('.area-meeting-card'),list=card?.querySelector('.area-screen-branches');if(!list)return;list.hidden=!list.hidden;const id=card?.dataset.areaId||list.dataset.areaId;if(id){if(list.hidden)areaExpandedGroups.delete(id);else areaExpandedGroups.add(id)}button.textContent=list.hidden?'عرض الفروع':'إخفاء الفروع';
  }
  async function refreshAreaDashboard(silent=true){
    if(areaRefreshRunning||!session?.token)return null;
    areaRefreshRunning=true;renderRegions();
    try{
      const result=await request('webBootstrap',{}),nextArea=result.area;if(!areaPayloadIsComplete(nextArea,areaPayload))throw new Error('التحديث الجديد لم يكتمل؛ بقيت آخر أرقام صحيحة ظاهرة');session.user=result.user;areaPayload=nextArea;saveSession(session);window.applyCloudBootstrap(result);renderRegions();renderOwnerRegions();if(!silent)window.toast('تم تحديث بيانات المنطقة • '+areaUpdateStamp(areaPayload?.generatedAt));return result;
    }catch(error){
      if(isSessionFailure(error)){saveSession(null);clearInterval(areaLiveTimer);showGate(error.message||'انتهت الجلسة.');return null}
      if(!silent)window.toast(error.message||'تعذر تحديث بيانات المنطقة');return null;
    }finally{areaRefreshRunning=false;renderRegions()}
  }
  function startAreaLive(){
    clearInterval(window.PORTABLE_LIVE_TIMER);clearInterval(areaLiveTimer);
    const seconds=Math.max(30,Number(CONFIG.pollSeconds||60));
    areaLiveTimer=setInterval(()=>{if(!document.hidden&&!document.body.classList.contains('portal-locked'))refreshAreaDashboard(true)},seconds*1000);
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
    ['areaGroupId','areaUserId','areaMeetingTitle','areaMeetingDescription','areaUsername','areaPassword','areaBranchSearch'].forEach(id=>{const node=document.getElementById(id);if(node)node.value=''});areaSelectedBranches=new Set();const enabled=document.getElementById('areaEnabled');if(enabled)enabled.checked=true;const title=document.getElementById('areaFormTitle');if(title)title.textContent='إضافة مجموعة منطقة';renderAreaCatalog();
  }
  function editAreaGroup(id){
    const group=areaGroups.find(item=>item.id===id);if(!group)return;document.getElementById('areaGroupId').value=group.id;document.getElementById('areaUserId').value=group.manager?.id||'';document.getElementById('areaMeetingTitle').value=group.title;document.getElementById('areaMeetingDescription').value=group.description||'';document.getElementById('areaUsername').value=group.manager?.username||'';document.getElementById('areaPassword').value='';document.getElementById('areaEnabled').checked=group.enabled;document.getElementById('areaFormTitle').textContent='تعديل '+group.title;areaSelectedBranches=new Set(group.branches.map(branch=>branch.branch||branch));renderAreaCatalog();scrollTo({top:document.getElementById('areaAdmin').offsetTop,behavior:'smooth'});
  }
  async function saveAreaGroup(){
    const message=document.getElementById('areaAdminMessage');message.textContent='جارٍ حفظ المجموعة والمستخدم…';
    const group={id:document.getElementById('areaGroupId').value,title:document.getElementById('areaMeetingTitle').value.trim(),description:document.getElementById('areaMeetingDescription').value.trim(),enabled:document.getElementById('areaEnabled').checked,branches:selectedAreaBranches()};
    const user={id:document.getElementById('areaUserId').value,username:document.getElementById('areaUsername').value.trim(),password:document.getElementById('areaPassword').value};
    try{await request('webUpsertAreaGroup',{group,user});message.textContent='تم حفظ المجموعة وحساب مدير المنطقة.';resetAreaForm();await loadAreaGroups();const refreshed=await request('webBootstrap',{});areaPayload=refreshed.area||areaPayload;renderRegions();renderOwnerRegions()}catch(error){message.textContent=error.message}
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
  window.WareedPortal={start,request,logout,loadUsers,renderUsers,editUser,deleteUser,saveUser,resetUserForm,permissions,canView,canAction,askAi,feedbackAi,loadAiStatus,saveAiConfig,loadAreaGroups,renderAreaCatalog,areaSelectionChanged,resetAreaForm,editAreaGroup,saveAreaGroup,deleteAreaGroup,toggleAreaBranches,refreshAreaDashboard,startAreaLive,renderOwnerRegions};
})();
