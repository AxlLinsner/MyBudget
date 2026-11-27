
const KEY='pbos_v3';
const LEGACY_KEY='pbos_iphone_v1';
const V2_KEY='pbos_v2';
const APP_VERSION='4.12.84';
const DB_SCHEMA_VERSION=1;
const BACKUP_FORMAT_VERSION=1;
const BACKUP_ITERATIONS=310000;
const RESTORE_PENDING_KEY='mybudget_restore_pending_v1';
const RESTORE_RECOVERY_DB='mybudget_restore_recovery_v1';
let restoreVerificationMode=false;
let storageStartupError=null;
let initialStoredDbRaw=null;
let db=null;
try{
  initialStoredDbRaw=localStorage.getItem(KEY);
  if(initialStoredDbRaw!==null)db=JSON.parse(initialStoredDbRaw);
}catch(error){
  storageStartupError=error;
}
const defaults={settings:{currency:'USD',startingCash:0,startingCashDate:'',saveTarget:500,incomeGrowth:0,appearance:{theme:'classic',iconPreset:'outline',density:'comfortable',customAccent:''}},categories:['Housing','Utilities','Groceries','Dining','Transportation','Fuel','Insurance','Subscriptions','Entertainment','Shopping','Healthcare','Personal','Travel','Education','Debt Payment','Savings','Investments','Other'],incomes:[],transactions:[],bills:[],billOccurrences:[],paychecks:[],paycheckOccurrences:[],assignments:[],budgets:[],debts:[],goals:[],assets:[],liabilities:[],investments:[],deletedGoalHistory:[]};
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
let startupRestoreMarker=null;
if(!storageStartupError){
  try{startupRestoreMarker=JSON.parse(localStorage.getItem(RESTORE_PENDING_KEY)||'null');}
  catch(error){storageStartupError=error;}
}
if(!storageStartupError&&startupRestoreMarker&&db?.restoreSessionId===startupRestoreMarker.sessionId)restoreVerificationMode=true;
else if(!storageStartupError&&startupRestoreMarker){
  try{localStorage.removeItem(RESTORE_PENDING_KEY);}
  catch(error){storageStartupError=error;}
}
if(!storageStartupError&&!db){
  try{
    const legacy=localStorage.getItem(LEGACY_KEY)||localStorage.getItem(V2_KEY);
    db=legacy?JSON.parse(legacy):structuredClone(defaults);
  }catch(error){storageStartupError=error;}
}
if(storageStartupError)db=structuredClone(defaults);
db.settings={...structuredClone(defaults.settings),...(db.settings||{})};
db.settings.appearance={...structuredClone(defaults.settings.appearance),...(db.settings.appearance||{})};
// Remove obsolete cloud-sync and custom-updater settings while preserving all financial data.
const hadObsoleteSettings=Object.prototype.hasOwnProperty.call(db.settings,'sync')||Object.prototype.hasOwnProperty.call(db.settings,'updates');
delete db.settings.sync;
delete db.settings.updates;
// Supabase stores persisted sessions under project-specific sb-*-auth-token keys.
let removedSupabaseSession=false;
if(!storageStartupError){
  try{
    for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key&&/^sb-.+-auth-token$/.test(key)){localStorage.removeItem(key);removedSupabaseSession=true;}}
  }catch(error){storageStartupError=error;}
}
// The normal, verified save later in startup persists these harmless settings cleanups.
db.categories=db.categories||structuredClone(defaults.categories);
const today=new Date(), localDateKey=d=>{let y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`}, currentMonth=()=>{let y=today.getFullYear(),m=String(today.getMonth()+1).padStart(2,'0');return `${y}-${m}`};
db.billOccurrences=Array.isArray(db.billOccurrences)?db.billOccurrences:[];
function migrateDebts(){
  db.debts=Array.isArray(db.debts)?db.debts.filter(d=>d&&typeof d==='object'):[];
  db.debts.forEach(d=>{
    if(!d.id)d.id='debt-'+uid();
    d.name=String(d.name||'Unnamed Debt').trim()||'Unnamed Debt';
    d.type=String(d.type||'Other');
    const legacyBalance=Number.isFinite(+d.balance)?+d.balance:0;
    if(!Number.isFinite(+d.startingBalance))d.startingBalance=Math.max(legacyBalance,0);
    if(!Number.isFinite(+d.currentBalance))d.currentBalance=Math.max(legacyBalance,0);
    d.startingBalance=Math.max(0,+d.startingBalance||0);
    d.currentBalance=Math.max(0,+d.currentBalance||0);
    d.balance=d.currentBalance; // legacy compatibility; currentBalance is authoritative going forward
    d.apr=Number.isFinite(+d.apr)?Math.max(0,+d.apr):0;
    d.minimum=Number.isFinite(+d.minimum)?Math.max(0,+d.minimum):0;
    d.extra=Number.isFinite(+d.extra)?Math.max(0,+d.extra):0;
    d.status=['active','paid-off','archived'].includes(d.status)?d.status:(d.currentBalance<=0?'paid-off':'active');
    d.createdAt=d.createdAt||iso(today);
    d.updatedAt=d.updatedAt||d.createdAt;
    // Debt history is derived exclusively from linked transactions now; retire the old manual history field.
    delete d.history;
    d.aprHistory=Array.isArray(d.aprHistory)?d.aprHistory.filter(h=>h&&/^\d{4}-\d{2}-\d{2}$/.test(String(h.date))&&Number.isFinite(+h.apr)).map(h=>({date:String(h.date),apr:Math.max(0,+h.apr)})):[];
    if(!d.aprHistory.length)d.aprHistory=[{date:d.startDate||d.createdAt,apr:d.apr}];
  });
}
function migrateBills(){
  db.bills=(db.bills||[]).map(b=>{
    if(!b.id)b.id='bill-'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
    if(!b.billType)b.billType=b.frequency==='one-time'?'one-time':'recurring';
    if(!b.amountType)b.amountType='fixed';
    if(b.expectedAmount==null)b.expectedAmount=+b.amount||0;
    if(!b.startDate){let day=Math.min(Math.max(+b.dueDay||1,1),28);b.startDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;}
    if(b.active==null)b.active=true;
    if(b.autopay==null)b.autopay=false;
    if(b.debtId!=null&&!db.debts.some(d=>String(d.id)===String(b.debtId)))b.debtId=null;
    if(!Object.prototype.hasOwnProperty.call(b,'debtId'))b.debtId=null;
    return b;
  });
}
if(!restoreVerificationMode)migrateBills();
function isOutflowTransaction(t){return t?.type==='expense'||t?.type==='bill'}
function transactionDescription(t){return t?.description||t?.payee||t?.note||t?.category||'Transaction'}
function transactionTypeLabel(t){return ({bill:'Bill',income:'Income',savings:'Savings',investment:'Investment',expense:'Expense'})[t?.type]||'Expense'}
function transactionTypeClass(t){return ['expense','bill','income','savings','investment'].includes(t?.type)?t.type:'expense'}
function migrateTransactions(){
  db.transactions=Array.isArray(db.transactions)?db.transactions:[];
  const validBillOccurrenceIds=new Set(db.billOccurrences.map(o=>o.id));
  db.transactions=db.transactions.filter(t=>t&&t.type!=='transfer').map(t=>{
    if(!t.id)t.id='tx-'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
    if(t.description==null)t.description=t.payee||'';
    delete t.payee;
    delete t.clears;
    if(t.billOccurrenceId&&validBillOccurrenceIds.has(t.billOccurrenceId))t.type='bill';
    if(!['expense','bill','income','savings','investment'].includes(t.type))t.type='expense';
    t.amount=Number.isFinite(+t.amount)?+t.amount:0;
    t.account=t.account||'';
    t.note=t.note||'';
    if(t.debtId!=null&&!db.debts.some(d=>String(d.id)===String(t.debtId)))t.debtId=null;
    if(!Object.prototype.hasOwnProperty.call(t,'debtId'))t.debtId=null;
    return t;
  });
}
if(!restoreVerificationMode)migrateTransactions();
function paycheckFrequencyLabel(f){return ({weekly:'Weekly',biweekly:'Biweekly','semi-monthly':'Semi-monthly',semimonthly:'Semi-monthly',monthly:'Monthly',quarterly:'Quarterly','one-time':'One-time',custom:'Custom'})[f]||'Custom'}
function normalizePaycheckFrequency(f){return f==='semi-monthly'?'semimonthly':f||'one-time'}
function paycheckStepDate(p,date){let f=normalizePaycheckFrequency(p.frequency),d=parseDateParts(date);if(!d)return '';if(f==='weekly')return addDaysISO(date,7);if(f==='biweekly')return addDaysISO(date,14);if(f==='monthly')return addMonthsISO(date,1);if(f==='quarterly')return addMonthsISO(date,3);if(f==='semimonthly'){let first=Math.min(Math.max(Number(p.firstDay)||1,1),31),second=Math.min(Math.max(Number(p.secondDay)||15,1),31),year=d.getFullYear(),month=d.getMonth()+1,last=new Date(year,month,0).getDate(),candidates=[Math.min(first,last),Math.min(second,last)].sort((a,b)=>a-b);for(const day of candidates){if(day>d.getDate())return dateISO(year,month,day)}let nextMonth=addMonthsISO(date,1);let nd=parseDateParts(nextMonth),nextLast=new Date(nd.getFullYear(),nd.getMonth()+1,0).getDate();return dateISO(nd.getFullYear(),nd.getMonth()+1,Math.min(candidates[0],nextLast));}return ''}
function customPaycheckDates(p,min,max){let dates=Array.isArray(p.customDates)?p.customDates.slice():String(p.customDates||'').split(',').map(x=>x.trim()).filter(Boolean);return dates.filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)&&x>=min&&x<=max).sort()}
function nextPaycheckDate(p,from){let f=normalizePaycheckFrequency(p.frequency),target=from||localDateKey(today),cur=p.firstDate||target;if(f==='custom')return customPaycheckDates(p,target,'9999-12-31')[0]||null;let guard=0;while(cur<target&&guard++<600){let next=paycheckStepDate(p,cur);if(!next)break;cur=next}return cur}
function occurrenceBaseStatus(o){let todayKey=localDateKey(today);if(o.status==='not-deposited')return 'not-deposited';if(o.status==='deposited'&&o.transactionId)return 'deposited';if(o.status==='cancelled')return 'cancelled';if(o.status==='historical')return 'historical';if(o.scheduledDate>todayKey)return 'scheduled';return 'awaiting'}
function paycheckOccurrenceStatus(o){let st=occurrenceBaseStatus(o);return ({'not-deposited':'Not Deposited',deposited:'Deposited',scheduled:'Scheduled',awaiting:'Awaiting Deposit',historical:'Historical',cancelled:'Cancelled'})[st]||'Scheduled'}
function occurrenceStatusClass(st){return st==='Deposited'?'paid':st==='Awaiting Deposit'?'due':st==='Not Deposited'?'overdue':st==='Cancelled'?'partial':st==='Historical'?'upcoming':'upcoming'}
function getPaycheckSchedule(id){return db.paychecks.find(p=>p.id===id)}
function getPaycheckOccurrence(id){return db.paycheckOccurrences.find(o=>o.id===id)}
function occurrenceTransaction(o){return o?.transactionId?db.transactions.find(t=>t.id===o.transactionId&&t.type==='income'):null}
function paycheckScheduleActive(o){const p=o&&getPaycheckSchedule(o.paycheckId);return !!p&&p.active!==false}
function paycheckOccurrenceHasActualIncome(o){return !!occurrenceTransaction(o)}
function paycheckOccurrenceCountsAsPlanned(o){return !!o&&o.status!=='cancelled'&&o.status!=='not-deposited'&&paycheckScheduleActive(o)}
function paycheckOccurrenceVisibleInCalendar(o){return !!o&&o.status!=='cancelled'&&(paycheckScheduleActive(o)||paycheckOccurrenceHasActualIncome(o))}
function paycheckOccurrenceAmount(o){let n=Number.isFinite(+o.actualAmount)&&+o.actualAmount>0?+o.actualAmount:+o.expectedAmount;return Number.isFinite(n)?n:0}
function generatePaycheckOccurrences(){
  if(restoreVerificationMode)return;
  db.paychecks=Array.isArray(db.paychecks)?db.paychecks.filter(p=>p&&p.id):[];
  db.paycheckOccurrences=Array.isArray(db.paycheckOccurrences)?db.paycheckOccurrences.filter(o=>o&&o.id):[];
  const existing=new Set(db.paycheckOccurrences.map(o=>o.id));
  const min=addMonthsISO(localDateKey(today),-24),max=addMonthsISO(localDateKey(today),18),todayKey=localDateKey(today);
  const inactiveIds=new Set(db.paychecks.filter(p=>p.active===false).map(p=>p.id));
  if(inactiveIds.size){
    const removeIds=new Set(db.paycheckOccurrences.filter(o=>inactiveIds.has(o.paycheckId)&&!o.transactionId&&o.scheduledDate>=todayKey).map(o=>o.id));
    if(removeIds.size){db.assignments=db.assignments.filter(a=>!removeIds.has(a.paycheckOccurrenceId));db.paycheckOccurrences=db.paycheckOccurrences.filter(o=>!removeIds.has(o.id));}
  }
  db.paychecks.forEach(p=>{
    if(!p.firstDate||p.active===false)return;
    let f=normalizePaycheckFrequency(p.frequency),dates=[];
    if(f==='custom')dates=customPaycheckDates(p,min,max);
    else{let cur=nextPaycheckDate(p,min),guard=0;while(cur&&cur<=max&&guard++<600){if(cur>=min)dates.push(cur);if(f==='one-time')break;let next=paycheckStepDate(p,cur);if(!next||next===cur)break;cur=next;}}
    const desired=new Set(dates.map(date=>`po-${p.id}-${date}`));
    db.paycheckOccurrences=db.paycheckOccurrences.filter(o=>{
      if(o.paycheckId!==p.id||o.transactionId||o.overridden||o.scheduledDate<todayKey||desired.has(o.id))return true;
      const ids=Array.isArray(o.allocationIds)?o.allocationIds:[];
      if(ids.length)db.assignments=db.assignments.filter(a=>!ids.includes(a.id)&&a.paycheckOccurrenceId!==o.id);
      return false;
    });
    dates.forEach(date=>{let id=`po-${p.id}-${date}`;if(!existing.has(id)&&!db.paycheckOccurrences.some(o=>o.id===id)){db.paycheckOccurrences.push({id,paycheckId:p.id,scheduledDate:date,expectedAmount:Number.isFinite(+p.expectedAmount)?+p.expectedAmount:0,status:date>todayKey?'scheduled':(date===todayKey?'awaiting':'historical'),actualDate:null,actualAmount:null,transactionId:null,allocationIds:[]});existing.add(id)}});
  });
  db.paycheckOccurrences.forEach(o=>{let p=getPaycheckSchedule(o.paycheckId);if(p&&!o.overridden&&!o.transactionId){if(o.scheduledDate>=todayKey)o.expectedAmount=Number.isFinite(+p.expectedAmount)?+p.expectedAmount:o.expectedAmount;o.status=o.scheduledDate>todayKey?'scheduled':(o.status==='not-deposited'?'not-deposited':(o.scheduledDate===todayKey?'awaiting':'historical'))}});
}

function migratePaycheckPlan(){
  db.paycheckOccurrences=Array.isArray(db.paycheckOccurrences)?db.paycheckOccurrences:[];
  const oldPaychecks=Array.isArray(db.paychecks)?db.paychecks.slice():[];
  const migrated=[];
  oldPaychecks.forEach(old=>{
    if(!old||!old.id)return;
    let schedule={id:old.id,name:String(old.name||'Paycheck').trim()||'Paycheck',expectedAmount:Number.isFinite(+old.expectedAmount)?+old.expectedAmount:(Number.isFinite(+old.amount)?+old.amount:0),frequency:normalizePaycheckFrequency(old.frequency==='one-time'?'one-time':old.frequency||'one-time'),firstDate:old.firstDate||old.date||localDateKey(today),active:old.active!==false,createdAt:old.createdAt||localDateKey(today)};
    if(schedule.frequency==='semimonthly'){schedule.firstDay=Number(old.firstDay)||parseDateParts(schedule.firstDate)?.getDate()||1;schedule.secondDay=Number(old.secondDay)||15}
    if(schedule.frequency==='custom')schedule.customDates=Array.isArray(old.customDates)?old.customDates:(old.customDates?[old.customDates]:[schedule.firstDate]);
    migrated.push(schedule);
  });
  const legacy=Array.isArray(db.incomes)?db.incomes.slice():[];
  const sig=p=>`${String(p.name||'').trim().toLowerCase()}|${normalizePaycheckFrequency(p.frequency)}|${(+p.expectedAmount||0).toFixed(2)}`;
  const seen=new Set(migrated.map(sig));
  legacy.forEach((inc,i)=>{
    let amount=+inc.amount||0;if(amount<=0)return;
    let f=normalizePaycheckFrequency(inc.frequency==='annual'?'monthly':inc.frequency||'monthly');if(inc.frequency==='annual')amount=amount/12;
    let schedule={id:`income-migrated-${i}-${uid()}`,name:String(inc.name||'Legacy income').trim()||'Legacy income',expectedAmount:amount,frequency:f,firstDate:inc.startDate||inc.date||localDateKey(today),active:inc.active!==false,createdAt:inc.createdAt||localDateKey(today)};
    if(f==='semimonthly'){schedule.firstDay=1;schedule.secondDay=15}
    if(!seen.has(sig(schedule))){migrated.push(schedule);seen.add(sig(schedule))}
  });
  db.paychecks=migrated;
  generatePaycheckOccurrences();
  const txs=Array.isArray(db.transactions)?db.transactions:[];
  txs.forEach(t=>{
    if(t.type!=='income')return;
    let occ=t.paycheckOccurrenceId?getPaycheckOccurrence(t.paycheckOccurrenceId):null;
    if(!occ&&t.paycheckId){let p=getPaycheckSchedule(t.paycheckId);if(p){occ=db.paycheckOccurrences.find(o=>o.paycheckId===p.id&&o.scheduledDate===t.date&&!o.transactionId);if(!occ&&!db.paycheckOccurrences.some(o=>o.paycheckId===p.id&&o.scheduledDate===t.date)){let base=`po-${p.id}-${t.date}`,id=base,seq=1;while(db.paycheckOccurrences.some(o=>o.id===id))id=`${base}-${seq++}`;occ={id,paycheckId:p.id,scheduledDate:t.date,expectedAmount:Number.isFinite(+p.expectedAmount)?+p.expectedAmount:+t.amount||0,status:'historical',actualDate:null,actualAmount:null,transactionId:null,allocationIds:[],overridden:true};db.paycheckOccurrences.push(occ)}}}
    // Never infer a paycheck relationship from matching date and amount.
    // Only an existing occurrence link or an explicit legacy paycheckId may link income.
    if(occ&&(!occ.transactionId||occ.transactionId===t.id)){occ.transactionId=t.id;occ.actualDate=t.date;occ.actualAmount=+t.amount||0;occ.status='deposited';t.paycheckOccurrenceId=occ.id;delete t.paycheckId;}
    else if(!occ||occ.transactionId!==t.id){delete t.paycheckOccurrenceId;delete t.paycheckId;}
  });
  db.incomes=[];
  db.paychecks.forEach(p=>delete p.amount);
  db.paycheckOccurrences.forEach(o=>{if(o.transactionId){o.status='deposited'}else if(o.status!=='not-deposited'&&o.status!=='cancelled')o.status=o.scheduledDate>localDateKey(today)?'scheduled':(o.scheduledDate===localDateKey(today)?'awaiting':'historical')});
}

if(!restoreVerificationMode)['debts','goals'].forEach(type=>{(db[type]||[]).forEach(item=>{if(!Array.isArray(item.history))item.history=[]})});
function migrateSavingsGoals(){
  db.transactions=Array.isArray(db.transactions)?db.transactions:[];
  db.goals=Array.isArray(db.goals)?db.goals.filter(g=>g&&g.id):[];
  db.deletedGoalHistory=Array.isArray(db.deletedGoalHistory)?db.deletedGoalHistory.filter(g=>g&&g.id):[];
  db.goals.forEach(g=>{
    if(g.startingBalance==null)g.startingBalance=Number.isFinite(+g.saved)?+g.saved:0;
    if(!g.createdAt)g.createdAt=String(g.history?.[0]?.date||iso(today));
    if(!g.targetDate&&g.date)g.targetDate=g.date;
    if(g.status!=='archived')g.status='active';
    g.isEmergencyFund=g.isEmergencyFund===true;
    g.target=Number.isFinite(+g.target)?+g.target:0;
    g.startingBalance=Number.isFinite(+g.startingBalance)?Math.max(0,+g.startingBalance):0;
    g.startingTransactions=Array.isArray(g.startingTransactions)?g.startingTransactions.filter(x=>x&&typeof x==='object'&&Number.isFinite(+x.amount)&&+x.amount>0).map(x=>({transactionId:String(x.transactionId||''),date:String(x.date||g.createdAt).slice(0,10),description:String(x.description||'Starting savings'),amount:+x.amount})):[];
    if(!Array.isArray(g.history)||!g.history.length)g.history=[{date:g.createdAt,value:g.startingBalance+g.startingTransactions.reduce((sum,x)=>sum+x.amount,0)}];
  });
  db.transactions.forEach(t=>{if(t.type==='savings'&&t.goalId==null&&t.savingsGoalId!=null)t.goalId=t.savingsGoalId;delete t.savingsGoalId});
}
function goalTransactions(goalId){return db.transactions.filter(t=>t.type==='savings'&&String(t.goalId||'')===String(goalId));}
function goalStartingTransactionIds(){return new Set([...db.goals,...(db.deletedGoalHistory||[])].flatMap(g=>(Array.isArray(g.startingTransactions)?g.startingTransactions:[]).map(x=>String(x.transactionId||'')).filter(Boolean)));}
function eligibleGoalStartingTransactions(){const used=goalStartingTransactionIds();return db.transactions.filter(t=>t&&t.type==='savings'&&!t.goalId&&Number.isFinite(+t.amount)&&+t.amount>0&&!used.has(String(t.id))&&/^\d{4}-\d{2}-\d{2}$/.test(String(t.date||''))).sort((a,b)=>String(b.date).localeCompare(String(a.date)));}
function goalRecord(goalId){return db.goals.find(x=>x.id===goalId)||db.deletedGoalHistory.find(x=>x.id===goalId)||null;}
function goalBalanceAt(goalId,asOf=localDateKey(today)){
  const g=goalRecord(goalId);if(!g)return 0;
  const created=String(g.createdAt||'').slice(0,10);if(created&&String(asOf)<created)return 0;
  const manualBase=Number.isFinite(+g.startingBalance)?+g.startingBalance:0;
  const selectedStartingBase=(Array.isArray(g.startingTransactions)?g.startingTransactions:[]).reduce((sum,x)=>sum+(Number.isFinite(+x.amount)?+x.amount:0),0);
  return manualBase+selectedStartingBase+goalTransactions(goalId).filter(t=>(!created||String(t.date||'')>=created)&&String(t.date||'')<=asOf).reduce((s,t)=>s+(+t.amount||0),0);
}
function deletedGoalLabel(goalId){const g=db.deletedGoalHistory.find(x=>x.id===goalId);return g?`${g.name||'Savings goal'} — Target no longer exists`:'Target no longer exists';}

function goalBalance(goalId){return goalBalanceAt(goalId,localDateKey(today));}
function goalMonthsToTarget(targetDate){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(targetDate||'')))return null;
  const t=parseDateParts(targetDate),n=parseDateParts(localDateKey(today));
  if(!t||t<=n)return 0;
  return Math.max(1,(t.getFullYear()-n.getFullYear())*12+(t.getMonth()-n.getMonth())+(t.getDate()-n.getDate())/30);
}
function addForecastMonths(baseDate,months){
  const whole=Math.floor(months),fraction=Math.max(0,months-whole);
  const base=new Date(baseDate.getFullYear(),baseDate.getMonth(),Math.min(baseDate.getDate(),28));
  base.setMonth(base.getMonth()+whole);
  if(fraction>0){
    const daysInNextMonth=new Date(base.getFullYear(),base.getMonth()+1,0).getDate();
    base.setDate(base.getDate()+Math.max(1,Math.round(fraction*daysInNextMonth)));
  }
  return base;
}
function goalForecast(g){
  const todayKey=localDateKey(today),saved=goalBalance(g.id),remaining=Math.max(0,(+g.target||0)-saved),target=g.targetDate||g.date||'';
  if(g.status==='archived')return {saved,remaining,status:'Archived',message:'Archived goal',required:null,actual:null,completion:null,recentMonths:3,recentNet:null};
  if(remaining<=0)return {saved,remaining,status:'Goal reached',message:'Goal reached',required:0,actual:null,completion:null,recentMonths:3,recentNet:null};
  const months=goalMonthsToTarget(target);
  if(months===null)return {saved,remaining,status:'Forecast unavailable',message:'Add a target date to forecast this goal',required:null,actual:null,completion:null,recentMonths:3,recentNet:null};
  if(months===0)return {saved,remaining,status:'Behind — Target date passed',message:'Target date passed',required:null,actual:null,completion:null,recentMonths:3,recentNet:null};
  const required=remaining/months;
  const cutoff=addMonthsISO(todayKey,-3);
  const recent=goalTransactions(g.id).filter(t=>String(t.date||'')>cutoff&&String(t.date||'')<=todayKey);
  const recentNet=recent.reduce((s,t)=>s+(+t.amount||0),0);
  const actual=recentNet/3;
  if(!recent.length)return {saved,remaining,status:'Forecast unavailable',message:'No savings activity in the last 3 months',required,actual:null,completion:null,recentMonths:3,recentNet:0};
  if(actual<=0)return {saved,remaining,status:'Forecast unavailable',message:'Last 3 months show no positive net savings pace',required,actual,completion:null,recentMonths:3,recentNet};
  const ratio=actual/required;
  const status=ratio>1.1?'Ahead':ratio>=0.9?'On track':'Behind';
  const monthsToComplete=remaining/actual;
  const completion=addForecastMonths(new Date(today.getFullYear(),today.getMonth(),today.getDate()),monthsToComplete);
  return {saved,remaining,status,message:status,required,actual,completion:dateISO(completion.getFullYear(),completion.getMonth()+1,completion.getDate()),recentMonths:3,recentNet,monthsToComplete};
}
const iso=d=>{let x=new Date(d);return new Date(x.getTime()-x.getTimezoneOffset()*60000).toISOString().slice(0,10)};
const LOCAL_STORAGE_ESTIMATED_LIMIT=5*1024*1024;
let lastPersistedJson=initialStoredDbRaw;
let lastSuccessfulSaveAt=null;
let saveStatusState=storageStartupError?'unavailable':restoreVerificationMode?'restore':initialStoredDbRaw!==null?'loaded':'pending';
let saveStatusMessage=storageStartupError?`MyBudget could not safely complete its local-storage startup checks: ${storageStartupError.message||storageStartupError}`:'';
function formatStorageBytes(bytes){
  if(!Number.isFinite(bytes)||bytes<0)return 'Unavailable';
  if(bytes<1024)return `${bytes} B`;
  if(bytes<1024*1024)return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(2)} MB`;
}
function describeStorageError(error){
  if(error?.name==='QuotaExceededError'||error?.name==='NS_ERROR_DOM_QUOTA_REACHED')return 'Browser storage is full. Your last verified database remains the saved copy. Export a backup and free browser storage space before retrying.';
  if(error?.name==='SecurityError')return 'The browser blocked access to local storage. Check this site’s storage permissions and retry.';
  return `The database could not be saved or verified: ${error?.message||String(error)}. Your last verified database has been retained where the browser allowed it.`;
}
function updateSaveStatusUI(){
  const labels={saving:'Saving…',saved:'All changes saved',loaded:'Saved data loaded',pending:'Not saved yet',failed:'Changes not saved',unavailable:'Storage unavailable',restore:'Restore verification'};
  const pill=document.getElementById('saveStatusPill');
  if(pill){
    pill.textContent=labels[saveStatusState]||'Save status';
    pill.dataset.state=saveStatusState;
    pill.title=saveStatusMessage||(
      saveStatusState==='loaded'?'The existing database was read successfully from this device.':
      saveStatusState==='saved'?'The latest database write was read back and verified.':
      saveStatusState==='restore'?'Normal saving is paused while restored data is being verified.':''
    );
  }
  const state=document.getElementById('saveStatusDetail');
  if(state)state.textContent=labels[saveStatusState]||'Save status';
  const last=document.getElementById('lastSaveTime');
  if(last)last.textContent=lastSuccessfulSaveAt?`Last verified save this session: ${lastSuccessfulSaveAt.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`:
    saveStatusState==='loaded'?'Existing saved data was loaded successfully. A new save time will appear after your next change.':
    saveStatusState==='restore'?'Saving is paused until restore verification is completed.':'No successful save has been recorded this session.';
  const error=document.getElementById('saveErrorText');
  if(error){error.textContent=saveStatusMessage;error.hidden=!saveStatusMessage||!['failed','unavailable'].includes(saveStatusState);}
  const retry=document.getElementById('retrySaveBtn');
  if(retry)retry.hidden=saveStatusState!=='failed';
}
function updateStorageMonitor(){
  const dbSize=document.getElementById('databaseSize');
  const usage=document.getElementById('storageUsageLabel');
  const fill=document.getElementById('storageMeterFill');
  const state=document.getElementById('storageStatus');
  const note=document.getElementById('storageEstimateNote');
  if(!dbSize&&!usage&&!fill&&!state)return;
  try{
    const persisted=localStorage.getItem(KEY)??localStorage.getItem(LEGACY_KEY)??localStorage.getItem(V2_KEY);
    const dbBytes=persisted===null?0:new Blob([persisted]).size;
    let totalCodeUnits=0;
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);
      if(key!==null){const value=localStorage.getItem(key)||'';totalCodeUnits+=key.length+value.length;}
    }
    const estimatedBytes=totalCodeUnits*2;
    const percent=Math.min(100,estimatedBytes/LOCAL_STORAGE_ESTIMATED_LIMIT*100);
    if(dbSize)dbSize.textContent=formatStorageBytes(dbBytes);
    if(usage)usage.textContent=`${percent.toFixed(1)}% of an estimated 5 MiB localStorage allowance`;
    if(fill)fill.style.width=`${percent}%`;
    const level=percent>=95?'critical':percent>=85?'high':percent>=70?'warning':'healthy';
    if(state){state.textContent=level==='critical'?'Critical usage':level==='high'?'High usage':level==='warning'?'Storage warning':'Within estimated allowance';state.dataset.state=level;}
    if(fill)fill.dataset.state=level;
    if(note)note.textContent='Database size is measured from the saved MyBudget record. Overall usage is an estimate based on this origin’s localStorage keys and values; browsers may enforce different limits and accounting.';
  }catch(error){
    if(dbSize)dbSize.textContent='Unavailable';
    if(usage)usage.textContent='Could not read local storage usage.';
    if(fill)fill.style.width='0%';
    if(state){state.textContent='Storage unavailable';state.dataset.state='critical';}
    if(note)note.textContent=`The browser did not allow storage inspection: ${error.message||error}`;
  }
}
function setSaveStatus(state,message=''){
  saveStatusState=state;saveStatusMessage=message;updateSaveStatusUI();
}
function save(){
  if(restoreVerificationMode||storageStartupError)return false;
  setSaveStatus('saving');
  let serialized,writeCompleted=false;
  try{
    serialized=JSON.stringify(db);
    if(typeof serialized!=='string')throw new Error('The database could not be serialized.');
    localStorage.setItem(KEY,serialized);
    writeCompleted=true;
    if(localStorage.getItem(KEY)!==serialized)throw new Error('The saved database did not match the data MyBudget attempted to write');
    lastPersistedJson=serialized;
    lastSuccessfulSaveAt=new Date();
    setSaveStatus('saved');
    if(document.getElementById('data')?.classList.contains('active'))updateStorageMonitor();
    return true;
  }catch(error){
    if(writeCompleted){
      try{
        if(lastPersistedJson!==null)localStorage.setItem(KEY,lastPersistedJson);
        else localStorage.removeItem(KEY);
      }catch(rollbackError){}
    }
    setSaveStatus('failed',describeStorageError(error));
    if(document.getElementById('data')?.classList.contains('active'))updateStorageMonitor();
    return false;
  }
}
function migrateBudgets(){
  db.budgets=Array.isArray(db.budgets)?db.budgets:[];
  const fallbackMonth=currentMonth();
  const normalized=db.budgets.filter(b=>b&&b.category).map(b=>{
    if(!b.id)b.id='budget-'+uid();
    if(b.amount==null)b.amount=Number.isFinite(+b.limit)?+b.limit:0;
    b.amount=Number.isFinite(+b.amount)?Math.max(0,+b.amount):0;
    if(!/^\d{4}-\d{2}$/.test(String(b.effectiveMonth||'')))b.effectiveMonth=fallbackMonth;
    if(!b.createdAt)b.createdAt=iso(today);
    if(!b.updatedAt)b.updatedAt=b.createdAt;
    delete b.limit;
    return b;
  });
  const byKey=new Map();
  normalized.forEach(b=>{
    const key=`${b.category}\u0000${b.effectiveMonth}`;
    const existing=byKey.get(key);
    if(!existing){byKey.set(key,b);return;}
    const existingTime=Date.parse(existing.updatedAt||existing.createdAt||'')||0;
    const candidateTime=Date.parse(b.updatedAt||b.createdAt||'')||0;
    const winner=candidateTime>existingTime||(candidateTime===existingTime&&String(b.id)>String(existing.id))?b:existing;
    const loser=winner===b?existing:b;
    winner.createdAt=existing.createdAt&&b.createdAt?((Date.parse(existing.createdAt)||0)<(Date.parse(b.createdAt)||0)?existing.createdAt:b.createdAt):(winner.createdAt||loser.createdAt);
    byKey.set(key,winner);
  });
  db.budgets=[...byKey.values()].sort((a,b)=>String(a.effectiveMonth).localeCompare(String(b.effectiveMonth))||String(a.category).localeCompare(String(b.category)));
}
if(!restoreVerificationMode){
  migrateBudgets();
  migrateDebts();
  migrateSavingsGoals();
  recalculateDebtLedgers();
  save();
}
const $=id=>document.getElementById(id);
if(!restoreVerificationMode){migratePaycheckPlan();generatePaycheckOccurrences();db.schemaVersion=DB_SCHEMA_VERSION;save();}

const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:db.settings.currency||'USD',maximumFractionDigits:2}).format(+n||0);
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const dateText=s=>new Date(s+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
const ICONS={
 home:'<svg viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
 activity:'<svg viewBox="0 0 24 24"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>',
 plan:'<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h16"/></svg>',
 bills:'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>',
 report:'<svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16"/><path d="m7 15 4-4 3 2 5-7"/></svg>',
 settings:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 1.7-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-2.4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L8 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H6.7v-2.4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L8 8.6l1.7-1.7.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h2.4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.7 1.7-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2V14h-.2a1.7 1.7 0 0 0-1.5 1z"/></svg>',
 calendar:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h3M8 17h7"/></svg>',
 budget:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
 debt:'<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h11M4 17h7"/><path d="m16 15 3 3 3-3"/></svg>',
 goals:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
 wallet:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M16 14h2"/></svg>',
 chart:'<svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16"/><rect x="7" y="11" width="3" height="5" rx=".5"/><rect x="13" y="7" width="3" height="9" rx=".5"/></svg>'
};
const ICON_PRESETS={outline:{name:'Outline',desc:'Clean line icons'},rounded:{name:'Rounded',desc:'Softer, friendly shapes'},bold:{name:'Bold',desc:'Stronger visual weight'},minimal:{name:'Minimal',desc:'Simple symbols'}};
const THEME_ACCENTS={classic:'#2563eb',rose:'#c65f82',ledger:'#315c4b',aura:'#6b5cff',prism:'#6c4df6',solstice:'#b7791f',evergreen:'#28724d',mystic:'#7656a8',nightfall:'#72e06a',sakura:'#d46b91',zenGarden:'#71836a',neonTokyo:'#20d9cf'};
const THEMES={
 classic:{name:'Classic',desc:'Clean, professional and balanced',sw:['#f4f6f8','#ffffff','#2563eb']},rose:{name:'Rose',desc:'Warm, soft and modern',sw:['#fbf2f5','#ffffff','#c65f82']},ledger:{name:'Ledger',desc:'Refined financial editorial',sw:['#f3eee3','#fbf8f0','#315c4b']},aura:{name:'Aura',desc:'Soft gradients and calm contrast',sw:['#eef1f8','#ffffff','#6b5cff']},prism:{name:'Prism',desc:'Colorful and energetic',sw:['#f6f7fb','#ffffff','#6c4df6']},solstice:{name:'Solstice',desc:'Warm, optimistic and grounded',sw:['#faf4e8','#ffffff','#b7791f']},evergreen:{name:'Evergreen',desc:'Calm, natural and considered',sw:['#f1f5f1','#ffffff','#28724d']},mystic:{name:'Mystic',desc:'Deep violet with a light canvas',sw:['#f4f1f8','#ffffff','#7656a8']},nightfall:{name:'Nightfall',desc:'Premium dark interface',sw:['#0b0e12','#141820','#72e06a']},sakura:{name:'Sakura',desc:'Delicate pink with crisp surfaces',sw:['#fbf1f4','#ffffff','#d46b91']},zenGarden:{name:'Zen Garden',desc:'Quiet, natural minimalism',sw:['#f4f4ec','#fffef8','#71836a']},neonTokyo:{name:'Neon Tokyo',desc:'Vivid accents on a dark canvas',sw:['#090d16','#141a28','#20d9cf']}};
const THEME_MIGRATIONS={noir:'classic',ko:'zenGarden',ocean:'evergreen',raw:'classic'};
function normalizeAppearance(){
  db.settings=db.settings||{};let stored=db.settings.appearance=db.settings.appearance||{},a=restoreVerificationMode?{...stored}:stored;
  // Backup validation runs before restore. Normalization remains a runtime fallback
  // for ordinary app startup, but it no longer gets to silently repair imported data.
  if(THEME_MIGRATIONS[a.theme])a.theme=THEME_MIGRATIONS[a.theme];
  if(!THEMES[a.theme])a.theme='classic';
  a.iconPreset=['outline','rounded','bold','minimal'].includes(a.iconPreset)?a.iconPreset:'outline';
  a.cardStyle=['clean-elevated','modern-colorful','elegant-dark','soft-pastel','gradient-accent','minimal-modern'].includes(a.cardStyle)?a.cardStyle:'clean-elevated';
  a.iconShape=['standard','rounded','circle'].includes(a.iconShape)?a.iconShape:'standard';
  a.iconWeight=['light','regular','bold'].includes(a.iconWeight)?a.iconWeight:'regular';
  a.iconSize=['small','medium','large'].includes(a.iconSize)?a.iconSize:'medium';
  a.icons=a.icons&&typeof a.icons==='object'&&!Array.isArray(a.icons)?a.icons:{};
  a.density=['compact','comfortable','spacious'].includes(a.density)?a.density:'comfortable';
  a.customAccent=typeof a.customAccent==='string'?a.customAccent:'';return a;
}
const ICON_LIBRARY={home:'home',activity:'activity',plan:'plan',bills:'bills',report:'report',settings:'settings',calendar:'calendar',budget:'budget',debt:'debt',goals:'goals',wallet:'wallet',chart:'chart'};
function iconMarkup(key){return ICONS[ICON_LIBRARY[key]||key]||ICONS.home;}
function applyAppearance(){let a=normalizeAppearance(),theme=a.theme;document.documentElement.dataset.theme=theme;document.documentElement.dataset.cardStyle=a.cardStyle||'clean-elevated';document.documentElement.dataset.density=a.density;document.documentElement.dataset.iconPreset=['outline','rounded','bold','minimal'].includes(a.iconPreset)?a.iconPreset:'outline';document.body.classList.toggle('density-compact',a.density==='compact');document.body.classList.toggle('density-spacious',a.density==='spacious');document.documentElement.dataset.iconShape=a.iconShape;document.documentElement.dataset.iconWeight=a.iconWeight;document.documentElement.dataset.iconSize=a.iconSize;document.documentElement.style.setProperty('--accent',THEME_ACCENTS[theme]||THEME_ACCENTS.classic);document.querySelectorAll('[data-icon]').forEach(el=>{let key=a.icons[el.dataset.iconSlot]||el.dataset.icon;el.innerHTML=iconMarkup(key);});if($('themeStatus'))$('themeStatus').textContent=THEMES[theme].name;}
function renderAppearanceSettings(){let a=normalizeAppearance();const cardStyles=[['clean-elevated','Clean Elevated','Neutral surfaces, subtle borders and soft shadows.'],['modern-colorful','Modern Colorful','Full category-tinted card surfaces with stronger color.'],['elegant-dark','Elegant Dark','Deep card surfaces with refined contrast, regardless of app theme.'],['soft-pastel','Soft Pastel','Complete card surfaces in gentle pastel tints.'],['gradient-accent','Gradient Accent','Subtle full-surface gradients for summary cards.'],['minimal-modern','Minimal Modern','Flat surfaces, thin borders and minimal decoration.']];if($('cardStyleChoices'))$('cardStyleChoices').innerHTML=cardStyles.map(([k,n,d])=>`<button type="button" class="cardStyleChoice ${a.cardStyle===k?'selected':''}" data-card-style-choice="${k}" aria-pressed="${a.cardStyle===k}"><span class="cardStylePreview"><i></i><i></i><i></i><i></i></span><strong>${n}</strong><small>${d}</small></button>`).join('');if($('themeChoices'))$('themeChoices').innerHTML=Object.entries(THEMES).map(([k,t])=>`<button class="choice ${a.theme===k?'selected':''}" data-theme-choice="${k}"><div class="themeSwatches">${t.sw.map(c=>`<i style="background:${c}"></i>`).join('')}</div><strong>${t.name}</strong><small>${t.desc}</small></button>`).join('');
const targets=[['dashboard','Dashboard'],['transactions','Transactions'],['plan','Paycheck Plan'],['bills','Bills'],['reports','Forecasts & Reports'],['annual','Annual Dashboard'],['budgets','Budgets'],['debts','Debt Payoff'],['goals','Savings Goals'],['data','Settings']];
const options=Object.keys(ICON_LIBRARY).map(k=>`<option value="${k}">${k.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}</option>`).join('');
if($('iconChoices'))$('iconChoices').innerHTML=`<div class="iconSettingsGrid">${targets.map(([key,label])=>`<label class="field iconSetting"><span>${label}</span><select data-icon-setting="${key}" aria-label="${label} icon">${options}</select></label>`).join('')}</div><div class="formgrid section"><div class="field"><label for="iconShapeSetting">Icon shape</label><select id="iconShapeSetting"><option value="standard">Standard</option><option value="rounded">Rounded</option><option value="circle">Circle</option></select></div><div class="field"><label for="iconWeightSetting">Icon weight</label><select id="iconWeightSetting"><option value="light">Light</option><option value="regular">Regular</option><option value="bold">Bold</option></select></div><div class="field"><label for="iconSizeSetting">Icon size</label><select id="iconSizeSetting"><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></div></div><p class="mini">Icon choices change appearance only. Navigation destinations and financial calculations remain unchanged.</p>`;
document.querySelectorAll('[data-icon-setting]').forEach(el=>{el.value=a.icons[el.dataset.iconSetting]||({dashboard:'home',transactions:'activity',plan:'plan',bills:'bills',reports:'report',annual:'report',budgets:'plan',debts:'activity',goals:'home',data:'settings'}[el.dataset.iconSetting]);el.onchange=()=>{db.settings.appearance.icons[el.dataset.iconSetting]=el.value;save();applyAppearance();};});[['iconShapeSetting','iconShape'],['iconWeightSetting','iconWeight'],['iconSizeSetting','iconSize']].forEach(([id,key])=>{let el=$(id);if(el){el.value=a[key];el.onchange=()=>{db.settings.appearance[key]=el.value;save();applyAppearance();};}});
document.querySelectorAll('[data-theme-choice]').forEach(b=>b.onclick=()=>{db.settings.appearance.theme=b.dataset.themeChoice;save();applyAppearance();renderAppearanceSettings();});document.querySelectorAll('[data-card-style-choice]').forEach(b=>b.onclick=()=>{db.settings.appearance.cardStyle=b.dataset.cardStyleChoice;save();applyAppearance();renderAppearanceSettings();});}

applyAppearance();save();

function nav(page){document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===page));document.querySelectorAll('#nav button,#mobileNav button[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page));if($('mobileMoreBtn'))$('mobileMoreBtn').classList.toggle('active',!['dashboard','transactions','plan','bills'].includes(page));render();if(page==='data'){updateSaveStatusUI();updateStorageMonitor();}scrollTo(0,0)}
document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>nav(b.dataset.page));
document.querySelectorAll('#mobileNav button[data-page]').forEach(b=>b.onclick=()=>nav(b.dataset.page));
document.querySelectorAll('#mobileMorePanel button[data-page]').forEach(b=>b.onclick=()=>{nav(b.dataset.page);$('mobileMorePanel').hidden=true;$('mobileMoreBtn').setAttribute('aria-expanded','false');$('menuBtn').setAttribute('aria-expanded','false');});
$('mobileMoreBtn').onclick=()=>{let panel=$('mobileMorePanel');panel.hidden=!panel.hidden;$('mobileMoreBtn').setAttribute('aria-expanded',String(!panel.hidden));$('menuBtn').setAttribute('aria-expanded',String(!panel.hidden));};
$('quickAdd').onclick=()=>openModal('transaction');document.addEventListener('click',e=>{const panel=$('mobileMorePanel');if(panel&&!panel.hidden&&!panel.contains(e.target)&&!e.target.closest('#menuBtn')&&!e.target.closest('#mobileMoreBtn')){panel.hidden=true;$('mobileMoreBtn').setAttribute('aria-expanded','false');$('menuBtn').setAttribute('aria-expanded','false');}});

const sideStateKey='mybudget_sidebar_collapsed';try{if(localStorage.getItem(sideStateKey)==='1')document.body.classList.add('sidebar-collapsed');}catch(_){}$('menuBtn').onclick=()=>{if(innerWidth<=700){let panel=$('mobileMorePanel');panel.hidden=!panel.hidden;$('mobileMoreBtn').setAttribute('aria-expanded',String(!panel.hidden));$('menuBtn').setAttribute('aria-expanded',String(!panel.hidden));return;}document.body.classList.toggle('sidebar-collapsed');try{localStorage.setItem(sideStateKey,document.body.classList.contains('sidebar-collapsed')?'1':'0');}catch(_){}};
$('monthPill').textContent=today.toLocaleDateString(undefined,{month:'long',year:'numeric'});
$('addBtn').onclick=()=>openModal('transaction');

function actualIncomeFor(key){return txTotal('income',key)}
function parseDateParts(v){let [y,m,d]=String(v||'').split('-').map(Number);return Number.isFinite(y)&&Number.isFinite(m)&&Number.isFinite(d)?new Date(y,m-1,d):null}
function dateISO(y,m,d){let x=new Date(y,m-1,d);return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`}
function addMonthsISO(dateStr,n){let d=parseDateParts(dateStr);if(!d)return '';let day=d.getDate(),x=new Date(d.getFullYear(),d.getMonth()+n,1),last=new Date(x.getFullYear(),x.getMonth()+1,0).getDate();return dateISO(x.getFullYear(),x.getMonth()+1,Math.min(day,last))}
function addDaysISO(dateStr,n){let d=parseDateParts(dateStr);if(!d)return '';d.setDate(d.getDate()+n);return dateISO(d.getFullYear(),d.getMonth()+1,d.getDate())}
function billStep(b){return b.frequency==='weekly'?{days:7}:b.frequency==='biweekly'?{days:14}:b.frequency==='monthly'?{months:1}:b.frequency==='quarterly'?{months:3}:b.frequency==='semiannual'?{months:6}:b.frequency==='annual'?{months:12}:{months:1}}
function billOccurrenceAtIndex(start,index,step){if(!start||index<0)return null;if(step.days)return addDaysISO(start,index*step.days);return addMonthsISO(start,index*step.months)}
function occurrenceStatus(o){if(o.payments?.length||o.transactionId)return 'paid';let todayKey=localDateKey(today);if(o.dueDate<todayKey)return 'overdue';if(o.dueDate===todayKey)return 'due';return 'upcoming'}
function ensureBillOccurrences(){
  if(restoreVerificationMode)return;
  db.billOccurrences=Array.isArray(db.billOccurrences)?db.billOccurrences:[];
  const existing=new Set(db.billOccurrences.map(o=>o.id));
  const todayKey=localDateKey(today),min=addMonthsISO(todayKey,-24),max=addMonthsISO(todayKey,18);
  db.bills.forEach(b=>{if(!b.active)return;const start=b.startDate;if(!start)return;const step=billStep(b),generationStart=b.occurrenceGenerationStartDate||min;let index=0,cur=start,guard=0;while(cur&&cur<=max&&guard++<600){if(cur>=min&&cur>=generationStart){const liveForDate=db.billOccurrences.some(o=>String(o.billId)===String(b.id)&&String(o.dueDate)===cur&&o.superseded!==true);if(!liveForDate){const baseId=`bo-${b.id}-${cur}`;let id=baseId,suffix=1;while(existing.has(id))id=`${baseId}-r${suffix++}`;db.billOccurrences.push({id,billId:b.id,dueDate:cur,expectedAmount:+b.expectedAmount||+b.amount||0,status:'upcoming',paidDate:null,actualAmount:null,payments:[],transactionId:null,debtId:b.debtId||null});existing.add(id)}}if(b.billType==='one-time')break;index++;cur=billOccurrenceAtIndex(start,index,step)}});
  db.billOccurrences.forEach(o=>{let b=db.bills.find(x=>x.id===o.billId);if(b){if(o.expectedAmount==null&&b.active!==false&&!o.superseded&&String(o.dueDate||'')>todayKey)o.expectedAmount=+b.expectedAmount||+b.amount||0;if(o.debtId!=null&&!debtPaymentDateValid(o.debtId,o.dueDate))o.debtId=null;if(o.debtId==null&&b.debtId!=null&&!o.superseded&&occurrenceDisplayStatus(o)!=='paid'&&debtPaymentDateValid(b.debtId,o.dueDate))o.debtId=b.debtId;o.status=occurrenceStatus(o)}});
}
function getOccurrence(id){return db.billOccurrences.find(o=>o.id===id)}
function getBill(id){return db.bills.find(b=>b.id===id)}
function occurrencePayments(o){let ids=o.payments?.length?o.payments:(o.transactionId?[o.transactionId]:[]);return ids.map(id=>db.transactions.find(t=>t.id===id)).filter(Boolean)}
function occurrencePaidAmount(o){return occurrencePayments(o).reduce((s,t)=>s+(+t.amount||0),0)}
function occurrenceRemainingAmount(o){return Math.max(0,(+o?.expectedAmount||0)-occurrencePaidAmount(o))}
function occurrenceDisplayStatus(o){let paid=occurrencePaidAmount(o);if(paid>0&&paid<(+o.expectedAmount||0))return 'partial';return paid>=0&&paid>=(+o.expectedAmount||0)&&paid>0?'paid':occurrenceStatus(o)}
function billOccurrenceIncludedInPlannedHistory(o){const b=getBill(o?.billId);if(!b||o.superseded===true)return false;if(b.active===false){const recordedCutoff=String(b.deactivatedAt||''),cutoff=/^\d{4}-\d{2}-\d{2}$/.test(recordedCutoff)?recordedCutoff:localDateKey(today);if(String(o.dueDate||'')>cutoff)return false;}return true}
function billOccurrenceCountsAsObligation(o){let b=getBill(o.billId);return !!b&&b.active!==false&&!o.superseded&&occurrenceRemainingAmount(o)>0.005}
function unpaidOccurrencesForRange(start,end){ensureBillOccurrences();return db.billOccurrences.filter(o=>o.dueDate>=start&&o.dueDate<=end&&billOccurrenceCountsAsObligation(o))}
function upcomingBillOccurrences(limit=10){ensureBillOccurrences();let key=localDateKey(today);return db.billOccurrences.filter(o=>o.dueDate>=key&&billOccurrenceCountsAsObligation(o)).sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).slice(0,limit)}
function monthlyBillTotalFor(key){let start=`${key}-01`,end=dateISO(+key.slice(0,4),+key.slice(5),new Date(+key.slice(0,4),+key.slice(5),0).getDate());return unpaidOccurrencesForRange(start,end).reduce((s,o)=>s+occurrenceRemainingAmount(o),0)}
function dashboardOutflowsFor(key){
  const transactions=db.transactions
    .filter(x=>isOutflowTransaction(x)&&String(x.date||'').startsWith(key))
    .map(t=>{
      const occ=t.billOccurrenceId?getOccurrence(t.billOccurrenceId):null;
      const bill=occ?getBill(occ.billId):null;
      return {id:`tx-${t.id}`,txId:t.id,kind:t.type==='bill'?'billPayment':'transaction',name:transactionDescription(t),category:t.category||bill?.category||'Other',amount:+t.amount||0,date:t.date,frequency:'transaction',billOccurrenceId:t.billOccurrenceId||null,billName:bill?.name||null};
    });
  return {transactions,allTransactions:transactions,bills:transactions.filter(x=>x.kind==='billPayment'),billOutflows:transactions.filter(x=>x.kind==='billPayment'),entries:transactions};
}
function txTotal(type,m=null){return db.transactions.filter(x=>x.type===type&&(!m||String(x.date||'').startsWith(m))).reduce((s,x)=>s+(+x.amount||0),0)}
function transactionCashImpact(t){
  if(!t||!t.date)return 0;
  const amount=Number(t.amount)||0;
  if(t.type==='income')return amount;
  if(t.type==='expense'||t.type==='bill'||t.type==='savings'||t.type==='investment')return -amount;
  return 0;
}
function currentEstimatedCash(){
  const startDate=String(db.settings.startingCashDate||'');
  const startingCash=Number(db.settings.startingCash)||0;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate))return null;
  const todayKey=localDateKey(today);
  const transactionImpact=db.transactions.reduce((sum,t)=>{
    const date=String(t?.date||'');
    if(date<startDate||date>todayKey)return sum;
    return sum+transactionCashImpact(t);
  },0);
  return startingCash+transactionImpact;
}
function monthKeyFromDate(d){let y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0');return `${y}-${m}`}
function monthlyIncomeFor(key){return actualIncomeFor(key)}
function monthlyExpenseFor(key){return dashboardOutflowsFor(key).transactions.filter(x=>x.kind!=='billPayment').reduce((s,x)=>s+(+x.amount||0),0)}
function monthlyBillFor(key){return dashboardOutflowsFor(key).transactions.filter(x=>x.kind==='billPayment').reduce((s,x)=>s+(+x.amount||0),0)}
function monthlySpendingFor(key){return monthlyExpenseFor(key)+monthlyBillFor(key)}
function monthlySavingsFor(key){return txTotal('savings',key)}
function monthlyInvestmentFor(key){return txTotal('investment',key)}
function monthlyAvailableFor(key){return monthlyIncomeFor(key)-monthlySpendingFor(key)-monthlySavingsFor(key)-monthlyInvestmentFor(key)}
function budgetMonthLabel(key){if(!/^\d{4}-\d{2}$/.test(String(key||'')))return 'Unknown';let [y,m]=String(key).split('-').map(Number);return new Date(y,m-1,1).toLocaleDateString(undefined,{month:'long',year:'numeric'})}
function budgetApplicableRecords(month){let key=String(month||currentMonth());let byCategory=new Map();(db.budgets||[]).filter(b=>b&&b.category&&/^\d{4}-\d{2}$/.test(String(b.effectiveMonth||''))&&String(b.effectiveMonth)<=key&&Number.isFinite(+b.amount)&&+b.amount>=0).sort((a,b)=>String(a.effectiveMonth).localeCompare(String(b.effectiveMonth))||String(a.id).localeCompare(String(b.id))).forEach(b=>{byCategory.set(b.category,b)});return [...byCategory.values()]}
function debtCurrentBalance(d){return Number.isFinite(+d?.currentBalance)?Math.max(0,+d.currentBalance):Math.max(0,+d?.balance||0)}
function debtPlannedPayment(d){return Math.max(0,(Number.isFinite(+d?.minimum)?+d.minimum:0)+(Number.isFinite(+d?.extra)?+d.extra:0))}
function debtStartDate(d){return /^\d{4}-\d{2}-\d{2}$/.test(String(d?.startDate||''))?String(d.startDate):String(d?.createdAt||'').slice(0,10)}
function debtPaymentDateValid(debtId,date){if(!debtId)return true;let d=db.debts.find(x=>String(x.id)===String(debtId));if(!d)return false;let start=debtStartDate(d);return !start||String(date)>=start}
function debtLinkedTransactions(debtId){return db.transactions.filter(t=>String(t?.debtId||'')===String(debtId)&&['expense','bill'].includes(t.type)&&Number.isFinite(+t.amount)&&+t.amount>0&&/^\d{4}-\d{2}-\d{2}$/.test(String(t.date||''))).sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.id).localeCompare(String(b.id)))}
function debtAprAt(d,date){const target=String(date||'');const history=Array.isArray(d?.aprHistory)?d.aprHistory.slice().filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x.date||''))&&Number.isFinite(+x.apr)).sort((a,b)=>String(a.date).localeCompare(String(b.date))):[];let apr=Number.isFinite(+d?.apr)?Math.max(0,+d.apr):0;for(const h of history){if(String(h.date)<=target)apr=Math.max(0,+h.apr);else break}return apr}
function debtLedger(d,asOf=localDateKey(today)){
  const start=debtStartDate(d)||String(asOf);
  if(start>asOf)return {startingBalance:0,principal:0,rows:[],asOf,daysSinceLastPayment:0,accruedInterest:0,lastDate:start};
  let principal=Math.max(0,+d?.startingBalance||0),lastDate=start,interestDue=0,rows=[];
  const txs=debtLinkedTransactions(d?.id).filter(t=>t.date>=start&&t.date<=asOf);
  for(const t of txs){
    let cursor=lastDate,remainingDays=Math.max(0,Math.round((parseDateParts(t.date)-parseDateParts(lastDate))/86400000)),accruedTotal=0;
    while(remainingDays>0){
      const nextDate=String(debtAprAt(d,addDaysISO(cursor,1))===debtAprAt(d,cursor)?t.date:addDaysISO(cursor,1));
      const stepDays=Math.max(1,Math.min(remainingDays,Math.round((parseDateParts(nextDate)-parseDateParts(cursor))/86400000)));
      const apr=debtAprAt(d,cursor);
      const accrued=principal*Math.max(0,apr)/100/365*stepDays;
      accruedTotal+=accrued;interestDue+=accrued;cursor=addDaysISO(cursor,stepDays);remainingDays-=stepDays;
    }
    const amount=+t.amount||0;
    const interestPaid=Math.min(amount,interestDue);
    interestDue=Math.max(0,interestDue-interestPaid);
    const principalPaid=Math.min(principal,Math.max(0,amount-interestPaid));
    principal=Math.max(0,principal-principalPaid);
    const unappliedAmount=Math.max(0,amount-interestPaid-principalPaid);
    rows.push({transactionId:t.id,date:t.date,amount,accrualDays:Math.max(0,Math.round((parseDateParts(t.date)-parseDateParts(lastDate))/86400000)),accruedInterest:accruedTotal,interestPaid,principalPaid,unpaidInterest:interestDue,unappliedAmount,remainingPrincipal:principal});
    lastDate=t.date;
  }
  const asOfDays=Math.max(0,Math.round((parseDateParts(asOf)-parseDateParts(lastDate))/86400000));
  let cursor=lastDate,remainingDays=asOfDays,accruedSinceLast=0;
  while(remainingDays>0){const apr=debtAprAt(d,cursor),accrued=principal*Math.max(0,apr)/100/365;accruedSinceLast+=accrued;cursor=addDaysISO(cursor,1);remainingDays--;}
  interestDue+=accruedSinceLast;
  return {startingBalance:Math.max(0,+d?.startingBalance||0),principal,rows,asOf,daysSinceLastPayment:asOfDays,accruedInterest:interestDue,lastDate};
}
function recalculateDebtLedgers(){
  for(const d of db.debts){
    const ledger=debtLedger(d);
    d.currentBalance=Math.max(0,ledger.principal);
    d.balance=d.currentBalance;
    if(d.status!=='archived')d.status=d.currentBalance<=0.005?'paid-off':'active';
    d.paymentHistory=ledger.rows;
    d.accruedInterest=ledger.accruedInterest;
    d.updatedAt=d.updatedAt||d.createdAt||localDateKey(today);
  }
}
function debtPaymentRows(d){return debtLedger(d).rows.slice().reverse()}
function payoff(d){
  let balance=debtCurrentBalance(d),apr=Math.max(0,+d?.apr||0),payment=debtPlannedPayment(d),interest=0,months=0;
  if(balance<=0)return {months:0,interest:0,total:0,date:'Paid off'};
  if(payment<=0)return {months:Infinity,interest:0,total:Infinity,date:'—'};
  let dayCursor=new Date(today.getFullYear(),today.getMonth(),today.getDate());
  while(balance>0.005&&months<1200){
    const daysInPeriod=new Date(dayCursor.getFullYear(),dayCursor.getMonth()+1,0).getDate();
    let periodInterest=0;
    for(let day=0;day<daysInPeriod;day++)periodInterest+=balance*apr/100/365;
    if(payment<=periodInterest+0.000001)return {months:Infinity,interest:Infinity,total:Infinity,date:'—'};
    const principal=Math.min(balance,Math.max(0,payment-periodInterest));
    balance=Math.max(0,balance-principal);
    interest+=periodInterest;
    months++;
    dayCursor=new Date(dayCursor.getFullYear(),dayCursor.getMonth()+1,dayCursor.getDate());
  }
  const base=new Date(today.getFullYear(),today.getMonth()+months,1);
  return {months,interest,total:debtCurrentBalance(d)+interest,date:months>=1200?'—':base.toLocaleDateString(undefined,{month:'short',year:'numeric'})};
}
function debtPayments(){return db.debts.filter(d=>d.status==='active').reduce((s,d)=>s+debtPlannedPayment(d),0)}
function forecastSpendingBaseline(){
  // Three complete calendar months are required. A completed month with $0
  // ordinary expenses is still valid historical data; it contributes $0.
  const months=[]; const start=new Date(today.getFullYear(),today.getMonth()-3,1);
  for(let i=0;i<3;i++){const d=new Date(start.getFullYear(),start.getMonth()+i,1);months.push(monthKeyFromDate(d));}
  const totals=new Map();
  db.transactions.forEach(t=>{
    if(t?.type!=='expense'||!/^\d{4}-\d{2}-\d{2}$/.test(String(t.date||'')))return;
    const key=String(t.date).slice(0,7); if(!months.includes(key)||t.debtId)return;
    const amount=Number(t.amount)||0; if(amount<=0)return;
    const category=String(t.category||'Other').trim()||'Other';
    if(!totals.has(category))totals.set(category,[0,0,0]);
    totals.get(category)[months.indexOf(key)]+=amount;
  });
  const categories={};
  totals.forEach((values,category)=>{categories[category]=values.reduce((s,v)=>s+v,0)/3});
  return {available:true,months,categories,total:Object.values(categories).reduce((s,v)=>s+v,0)};
}
function forecastActualExpenseFor(key){const todayKey=localDateKey(today);return db.transactions.filter(t=>t?.type==='expense'&&!t.debtId&&String(t.date||'').startsWith(key)&&String(t.date||'')<=todayKey).reduce((s,t)=>s+(+t.amount||0),0)}
function futureTransactionsForMonth(key){const todayKey=localDateKey(today);return db.transactions.filter(t=>{const date=String(t?.date||'');return /^\d{4}-\d{2}-\d{2}$/.test(date)&&date>todayKey&&date.startsWith(key)&&['income','expense','bill','savings','investment'].includes(t.type);});}
function futureTransactionTotal(key,type){return futureTransactionsForMonth(key).filter(t=>t.type===type && !(type==='bill'&&t.billOccurrenceId)).reduce((s,t)=>s+(+t.amount||0),0)}
function datedTransactionTotal(key,type,throughToday=true){const todayKey=localDateKey(today);return db.transactions.filter(t=>t?.type===type&&String(t.date||'').startsWith(key)&&/^\d{4}-\d{2}-\d{2}$/.test(String(t.date||''))&&(throughToday?String(t.date)<=todayKey:String(t.date)>todayKey)).reduce((s,t)=>s+(+t.amount||0),0)}
function actualCurrentCashOutflowFor(key,type){if(key!==currentMonth()||!['savings','investment'].includes(type))return 0;return datedTransactionTotal(key,type,true)}
function fullMonthBillTotalFor(key){ensureBillOccurrences();return db.billOccurrences.filter(o=>String(o.dueDate||'').startsWith(key)&&getBill(o.billId)?.active!==false&&!o.superseded).reduce((s,o)=>s+Math.max(0,+o.expectedAmount||0),0)}
function futureBillTotalFor(key){ensureBillOccurrences();return db.billOccurrences.filter(o=>String(o.dueDate||'').startsWith(key)&&billOccurrenceCountsAsObligation(o)).reduce((s,o)=>s+occurrenceRemainingAmount(o),0)}
function futurePaycheckTotalFor(key){generatePaycheckOccurrences();const todayKey=localDateKey(today);return db.paycheckOccurrences.filter(o=>String(o.scheduledDate||'')>todayKey&&String(o.scheduledDate||'').startsWith(key)&&paycheckOccurrenceCountsAsPlanned(o)&&!o.transactionId).reduce((s,o)=>s+(+o.expectedAmount||0),0)}
function knownFutureActivityFor(key){const tx=futureTransactionsForMonth(key);const isCurrent=key===currentMonth(),todayKey=localDateKey(today);const futureIncome=futurePaycheckTotalFor(key)+futureTransactionTotal(key,'income');const actualIncome=isCurrent?datedTransactionTotal(key,'income',true):0;const income=actualIncome+futureIncome;const bills=futureBillTotalFor(key);const fullBills=fullMonthBillTotalFor(key);const savings=futureTransactionTotal(key,'savings');const investments=futureTransactionTotal(key,'investment');const actualSavings=actualCurrentCashOutflowFor(key,'savings');const actualInvestments=actualCurrentCashOutflowFor(key,'investment');const transactionBills=futureTransactionTotal(key,'bill');const actualTransactionBills=isCurrent?db.transactions.filter(t=>t?.type==='bill'&&!t.billOccurrenceId&&String(t.date||'').startsWith(key)&&String(t.date||'')<=todayKey).reduce((s,t)=>s+(+t.amount||0),0):0;return {income,futureIncome,bills,fullBills,transactions:transactionBills,actualTransactionBills,savings,investments,actualSavings,actualInvestments,transactionCount:tx.length};}
function cashPositionHistory(){let arr=[],d=new Date(today.getFullYear(),today.getMonth()-11,1);for(let i=0;i<12;i++){let key=monthKeyFromDate(d),available=monthlyAvailableFor(key);arr.push({key,available,inc:monthlyIncomeFor(key),spent:monthlyExpenseFor(key),bills:monthlyBillFor(key),savings:monthlySavingsFor(key),investments:monthlyInvestmentFor(key)});d.setMonth(d.getMonth()+1)}return arr}
function forecast(){const arr=[];let cash=currentEstimatedCash();if(cash===null)return arr;const currentKey=currentMonth(),baseline=forecastSpendingBaseline();let d=new Date(today.getFullYear(),today.getMonth(),1);for(let i=0;i<12;i++){const key=monthKeyFromDate(d),isCurrent=key===currentKey,known=knownFutureActivityFor(key);const projectedSpending=baseline.available?baseline.total:null;const actualSpent=baseline.available?forecastActualExpenseFor(key):null;const spendingRemaining=baseline.available?(isCurrent?Math.max(0,projectedSpending-actualSpent):projectedSpending):null;const projectedOutflowSpending=projectedSpending===null?null:(isCurrent?(actualSpent+spendingRemaining):projectedSpending);const savings=known.savings+known.actualSavings,investments=known.investments+known.actualInvestments;const projectedSavings=projectedSpending===null?null:known.income-projectedSpending-known.fullBills-known.actualTransactionBills-known.transactions-savings-investments;const net=spendingRemaining===null?null:known.futureIncome-spendingRemaining-known.bills-known.transactions-known.savings-known.investments;if(net!==null)cash+=net;else if(i>0)cash=null;arr.push({key,inc:known.income,b:known.fullBills,remainingBills:known.bills,sp:spendingRemaining,projectedSpending,projectedOutflowSpending,actualSpent,spendingRemaining,gi:known.savings+known.investments,savings,investments,actualSavings:known.actualSavings,actualInvestments:known.actualInvestments,knownTransactions:known.transactions,projectedSavings,net,cash,spendingBaseline:baseline.available?baseline.total:null,historyMonths:baseline.months,historyAvailable:baseline.available});d.setMonth(d.getMonth()+1);}return arr;}
function aggregateForecast(rows,period){if(period==='monthly')return rows.map(x=>({...x,label:budgetMonthLabel(x.key),startCash:x.cash!=null&&x.net!=null?x.cash-x.net:null}));const map=new Map();rows.forEach(x=>{const [y,m]=x.key.split('-').map(Number);const label=period==='quarterly'?`${y} Q${Math.ceil(m/3)}`:`${y}`;if(!map.has(label))map.set(label,{label,inc:0,b:0,sp:0,projectedSpending:0,projectedOutflowSpending:0,actualSpent:0,savings:0,investments:0,knownTransactions:0,net:0,projectedSavings:0,projectedSavingsAvailable:true,startCash:x.cash!=null&&x.net!=null?x.cash-x.net:null,cash:null});const g=map.get(label);g.inc+=x.inc;g.b+=x.b;g.sp+=x.sp||0;g.projectedSpending+=x.projectedSpending||0;g.projectedOutflowSpending+=x.projectedOutflowSpending||0;g.actualSpent+=x.actualSpent||0;g.savings+=x.savings;g.investments+=x.investments;g.knownTransactions+=x.knownTransactions;g.net+=x.net||0;if(x.projectedSavings==null)g.projectedSavingsAvailable=false;else g.projectedSavings+=x.projectedSavings;g.cash=x.cash;});return [...map.values()].map(g=>({...g,projectedSavings:g.projectedSavingsAvailable?g.projectedSavings:null}));}

const FINANCE_CHART_COLORS={income:'#16834a',expense:'#c43d42',bills:'#2874c8',savings:'#8056c9',investments:'#b88712',debt:'#64748b'};
const PIE_CHART_COLORS=['#3979C6','#E58B43','#42A58A','#9B79C9','#D65F75','#D5AE42','#45A6B8','#8796A8','#8DAD55','#C47B9B'];
function chartTheme(c){const st=getComputedStyle(c);return {text:st.getPropertyValue('--text').trim()||'#101828',muted:st.getPropertyValue('--muted').trim()||'#667085',grid:st.getPropertyValue('--line').trim()||'#e4e7ec',surface:st.getPropertyValue('--panel').trim()||'#fff'};}
function setChartLegend(id,items){let root=$(id);if(!root)return;root.innerHTML=items.map(item=>`<span class="annualLegendItem"><i style="background:${item.color}"></i>${esc(item.label)}</span>`).join('');}
function chartTipEvents(c,tip,handler){
  c.onmousemove=e=>handler(e,false);
  c.onclick=e=>handler(e,true);
  c.onpointerdown=e=>{if(e.pointerType==='touch')c._touchSelect=true};
  c.onmouseleave=e=>{
    const next=e.relatedTarget;
    if(tip&&(next===tip||tip.contains(next)))return;
    if(tip&&!tip._selected)tip.style.display='none';
  };
  if(tip){
    tip.onmouseenter=()=>{};
    tip.onmouseleave=e=>{
      if(e.relatedTarget===c)return;
      if(!tip._selected)tip.style.display='none';
    };
  }
  c.ontouchend=e=>{const t=e.changedTouches?.[0];if(t)handler({clientX:t.clientX,clientY:t.clientY},true)};
}
const MOBILE_MONTH_CHARTS=new Set(['dashCash','incomeOutChart','projectionChart','annualQuarterChart','annualMonthlyChart']);
const MOBILE_SCROLL_CHARTS=new Set(['debtChart']);
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
const chartMonthSelections={};
function chartMonthLabel(k){if(/^\d{4}-\d{2}$/.test(k)){const m=Number(k.slice(5,7));return MONTH_NAMES[m-1]||k;}if(/^\d{1,2}$/.test(k)){const m=Number(k);return MONTH_NAMES[m-1]||k;}if(/^[A-Za-z]{3}$/.test(k)){const i=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(k);return MONTH_NAMES[i]||k;}if(/^[A-Za-z]+$/.test(k)){return MONTH_NAMES.find(m=>m.toLowerCase()===k.toLowerCase())||k;}return k;}
function chartRowsForMonths(id,source,selected){if(!selected||selected.size===12)return source||[];if(selected.size===0)return [];return (source||[]).filter(v=>{const k=v.key||v.l||v.label||'';if(id==='annualQuarterChart'){const q=/Q([1-4])/.exec(k);return q&&MONTH_NAMES.some((m,i)=>selected.has(m)&&Math.floor(i/3)+1===Number(q[1]));}return selected.has(chartMonthLabel(k));});}
function chartMonthSelector(id,data){if(!MOBILE_MONTH_CHARTS.has(id)||window.innerWidth>700)return;const c=$(id);if(!c)return;const card=c.closest('.card');let head=card?.querySelector('.sectionhead');if(!head){const h2=card?.querySelector('h2');if(!h2)return;head=document.createElement('div');head.className='sectionhead';h2.parentNode.insertBefore(head,h2);head.appendChild(h2);}if(!head)return;let ctl=head.querySelector(`[data-month-selector="${id}"]`);if(!ctl){ctl=document.createElement('div');ctl.dataset.monthSelector=id;ctl.className='mobileMonthSelector';ctl.innerHTML=`<button type="button" class="btn small monthSelectBtn" aria-expanded="false">Months ▾</button><div class="monthSelectPanel" hidden></div>`;head.appendChild(ctl);ctl.querySelector('button').onclick=()=>{const panel=ctl.querySelector('.monthSelectPanel');panel.hidden=!panel.hidden;ctl.querySelector('button').setAttribute('aria-expanded',String(!panel.hidden));};}
 const options=MONTH_NAMES.slice();if(!chartMonthSelections[id])chartMonthSelections[id]=new Set(options);const chosen=chartMonthSelections[id];const button=ctl.querySelector('.monthSelectBtn');button.textContent=chosen.size===12?'Months ▾':`${chosen.size} selected ▾`;const panel=ctl.querySelector('.monthSelectPanel');const isOpen=!panel.hidden;panel.innerHTML=`<div class="monthSelectActions"><button type="button" data-all>All months</button><button type="button" data-none>Clear</button></div>`+options.map(m=>`<label><input type="checkbox" ${chosen.has(m)?'checked':''}> <span>${m}</span></label>`).join('');panel.hidden=!isOpen;button.setAttribute('aria-expanded',String(isOpen));panel.querySelectorAll('label input').forEach((input,i)=>input.onchange=()=>{input.checked?chosen.add(options[i]):chosen.delete(options[i]);button.textContent=chosen.size===12?'Months ▾':`${chosen.size} selected ▾`;renderSelectedChart(id);});panel.querySelector('[data-all]').onclick=()=>{options.forEach(m=>chosen.add(m));renderSelectedChart(id);};panel.querySelector('[data-none]').onclick=()=>{chosen.clear();renderSelectedChart(id);};}
function renderSelectedChart(id){const c=$(id);if(!c||!c._chartSource)return;const chosen=chartMonthSelections[id];canvas(id,c._chartMode,chartRowsForMonths(id,c._chartSource,chosen),true);}
function canvas(id,mode,data,preserveSource=false){
  const c=$(id);if(!c)return;
  if(!preserveSource){c._chartSource=data||[];c._chartMode=mode;}
  chartMonthSelector(id,c._chartSource||data);
  if(MOBILE_MONTH_CHARTS.has(id)&&window.innerWidth<=700&&chartMonthSelections[id])data=chartRowsForMonths(id,c._chartSource,chartMonthSelections[id]);
  c._chartData=data||[];c.onmousemove=null;c.onclick=null;c.onmouseleave=null;c.ontouchend=null;
  const tipId=id==='dashCash'?'cashTip':id==='dashSpend'?'spendTip':id==='incomeOutChart'?'incomeOutTip':id==='projectionChart'?'projectionTip':id+'Tip';const tip=$(tipId);if(tip){tip.style.display='none';tip._selected=false;}
  const rows=(data||[]).length;
  let w=Math.max(300,c.clientWidth||500);if(MOBILE_SCROLL_CHARTS.has(id)&&window.innerWidth<=700)w=Math.max(w,rows*76);let h=mode==='hbars'?Math.max(245,rows*48+30):245;
  const dpr=window.devicePixelRatio||1;c.style.height=h+'px';c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);
  const x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);x.font='11px system-ui';
  const theme=chartTheme(c),pad={l:mode==='hbars'?14:42,r:14,t:mode==='pie'?36:16,b:mode==='hbars'?14:30},pw=w-pad.l-pad.r,ph=h-pad.t-pad.b;
  if(!rows){x.fillStyle=theme.muted;x.fillText('No data yet',20,30);return;}
  const fmt=v=>money(Number(v)||0),maxOf=arr=>Math.max(1,...arr.map(v=>Number(v)||0));
  const drawGrid=(min,max)=>{const span=Math.max(1,max-min);x.font='10px system-ui';for(let i=0;i<4;i++){const val=max-span*i/3,yy=pad.t+ph*i/3;x.strokeStyle=theme.grid;x.beginPath();x.moveTo(pad.l,yy);x.lineTo(w-pad.r,yy);x.stroke();x.fillStyle=theme.muted;x.textAlign='right';x.fillText(compactMoney(val),pad.l-6,yy+3);}x.textAlign='left';};
  if(mode==='line'){
    const vals=data.map(v=>v.v==null?null:Number(v.v)).filter(v=>v!==null&&Number.isFinite(v)),max=Math.max(0,...vals),min=Math.min(0,...vals),span=Math.max(1,max-min),yFor=v=>pad.t+ph*(1-(v-min)/span);
    drawGrid(min,max);x.strokeStyle=id==='projectionChart'?FINANCE_CHART_COLORS.savings:id==='annualActualBillsChart'?FINANCE_CHART_COLORS.bills:FINANCE_CHART_COLORS.income;x.lineWidth=2.5;x.lineJoin='round';x.lineCap='round';x.beginPath();
    let drawing=false;data.forEach((v,i)=>{if(v.v==null||!Number.isFinite(Number(v.v))){drawing=false;return;}const xx=pad.l+pw*(i/(data.length-1||1)),yy=yFor(Number(v.v));if(drawing)x.lineTo(xx,yy);else x.moveTo(xx,yy);drawing=true;});x.stroke();
    data.forEach((v,i)=>{if(v.v==null||!Number.isFinite(Number(v.v)))return;const xx=pad.l+pw*(i/(data.length-1||1)),yy=yFor(Number(v.v));x.fillStyle=theme.surface;x.strokeStyle=id==='projectionChart'?FINANCE_CHART_COLORS.savings:id==='annualActualBillsChart'?FINANCE_CHART_COLORS.bills:FINANCE_CHART_COLORS.income;x.lineWidth=2;x.beginPath();x.arc(xx,yy,3.5,0,Math.PI*2);x.fill();x.stroke();if(i%2===0||i===data.length-1){x.fillStyle=theme.muted;x.textAlign='center';x.fillText(v.l,xx,h-9)}});x.textAlign='left';
    c._chartMeta={pad,pw,ph,w,h,yFor,mode};
    if(id==='dashCash')chartTipEvents(c,tip,(e,keep)=>showCashTip(e,c,tip,keep));
    if(id==='projectionChart')chartTipEvents(c,tip,(e,keep)=>showProjectionTip(e,c,tip,keep));else if(id==='annualActualBillsChart')chartTipEvents(c,tip,(e,keep)=>showAnnualChartTip(e,c,keep));
  }else if(mode==='pie'){
    const total=data.reduce((a,v)=>a+(Number(v.v)||0),0),cx=w/2,cy=pad.t+ph/2,r=Math.min(78,ph*.43),colors=PIE_CHART_COLORS;
    x.fillStyle=theme.muted;x.font='11px system-ui';x.fillText('Total',12,17);x.fillStyle=theme.text;x.font='bold 14px system-ui';x.fillText(fmt(total),49,18);
    let angle=-Math.PI/2;data.forEach((v,i)=>{const sweep=total>0?(Number(v.v)||0)/total*Math.PI*2:0;x.beginPath();x.moveTo(cx,cy);x.arc(cx,cy,r,angle,angle+sweep);x.closePath();x.fillStyle=colors[i%colors.length];x.fill();angle+=sweep;});
    c._chartMeta={w,h,mode,cx,cy,r};
    if(id==='dashSpend')chartTipEvents(c,tip,(e,keep)=>showSpendTip(e,c,tip,keep));
    else if(id.startsWith('annual'))chartTipEvents(c,tip,(e,keep)=>showAnnualChartTip(e,c,keep));
  }else if(mode==='hbars'){
    const max=maxOf(data.map(v=>v.amount??v.v??v.a)),rowH=ph/data.length,barColor=id==='debtChart'?FINANCE_CHART_COLORS.debt:FINANCE_CHART_COLORS.bills;
    data.forEach((v,i)=>{const rowTop=pad.t+i*rowH,amount=Number(v.amount??v.v??v.a)||0,bw=pw*amount/max,label=String(v.name||v.l||'');x.font='600 11px system-ui';x.fillStyle=theme.text;x.textAlign='left';x.fillText(label,pad.l,rowTop+12,Math.max(40,pw-100));x.font='700 11px system-ui';x.fillStyle=theme.text;x.textAlign='right';x.fillText(fmt(amount),w-pad.r,rowTop+12);const trackY=rowTop+21,trackH=9;x.fillStyle=theme.grid;x.beginPath();x.roundRect(pad.l,trackY,pw,trackH,5);x.fill();x.fillStyle=barColor;x.beginPath();x.roundRect(pad.l,trackY,Math.max(1,bw),trackH,5);x.fill();});x.textAlign='left';
    c._chartMeta={w,h,pad,pw,ph,mode};if(id.startsWith('annual'))chartTipEvents(c,tip,(e,keep)=>showAnnualChartTip(e,c,keep));else if(id==='debtChart')chartTipEvents(c,tip,(e,keep)=>showDebtTip(e,c,tip,keep));
  }else if(mode==='grouped'||mode==='forecast'){
    const series=mode==='forecast'?[{key:'inc',label:'Income',color:FINANCE_CHART_COLORS.income},{key:'projectedSpending',label:'Projected expenses',color:FINANCE_CHART_COLORS.expense},{key:'knownBills',label:'Known bills',color:FINANCE_CHART_COLORS.bills},{key:'knownTransactions',label:'Future transactions',color:FINANCE_CHART_COLORS.debt},{key:'savings',label:'Savings',color:FINANCE_CHART_COLORS.savings},{key:'investments',label:'Investments',color:FINANCE_CHART_COLORS.investments}]:[{key:'earned',label:'Income',color:FINANCE_CHART_COLORS.income},{key:'expenses',label:'Expenses',color:FINANCE_CHART_COLORS.expense},{key:'billsPaid',label:'Bills paid',color:FINANCE_CHART_COLORS.bills},{key:'net',label:'Net cash flow',color:FINANCE_CHART_COLORS.debt}];
    const all=mode==='forecast'?data.map(v=>Math.max(0,Number(v.inc)||0)+series.slice(1).reduce((sum,s)=>sum+Math.max(0,Number(v[s.key])||0),0)).concat(data.map(v=>Math.max(0,Number(v.inc)||0))):data.flatMap(v=>series.map(s=>Number(v[s.key])||0)),min=mode==='forecast'?0:Math.min(0,...all),max=Math.max(1,...all),span=Math.max(1,max-min),yFor=v=>pad.t+ph*(1-(v-min)/span),zero=yFor(0);drawGrid(min,max);x.strokeStyle=theme.muted;x.beginPath();x.moveTo(pad.l,zero);x.lineTo(w-pad.r,zero);x.stroke();
    const groupW=pw/data.length,bw=mode==='forecast'?Math.max(5,Math.min(16,groupW*.26)):Math.max(2,Math.min(14,groupW/(series.length+1)));
    data.forEach((v,i)=>{const gx=pad.l+groupW*i+groupW/2;if(mode==='forecast'){
      const inc=Number(v.inc)||0;x.fillStyle=FINANCE_CHART_COLORS.income;x.fillRect(gx-bw*1.3,yFor(inc),bw,Math.max(1,zero-yFor(inc)));
      let stack=0;series.slice(1).forEach(s=>{const val=Math.max(0,Number(v[s.key])||0);if(val){const y1=yFor(stack+val),y0=yFor(stack);x.fillStyle=s.color;x.fillRect(gx+bw*.3,y1,bw,Math.max(1,y0-y1));stack+=val;}});
    }else{series.forEach((s,j)=>{const val=Number(v[s.key])||0,y=yFor(val),base=yFor(0);x.fillStyle=s.color;x.fillRect(gx-(series.length*bw)/2+j*bw,Math.min(y,base),bw-1,Math.max(1,Math.abs(base-y)));});}
      x.fillStyle=theme.muted;x.font='9px system-ui';x.textAlign='center';if(i%Math.ceil(data.length/6)===0||i===data.length-1)x.fillText(v.l||v.key||'',gx,h-9);
    });x.textAlign='left';
    c._chartMeta={pad,pw,ph,max,min,w,h,mode,series};
    if(id==='incomeOutChart')chartTipEvents(c,tip,(e,keep)=>showIncomeOutTip(e,c,tip,keep));
    if(id.startsWith('annual'))chartTipEvents(c,tip,(e,keep)=>showAnnualChartTip(e,c,keep));
    if(mode==='forecast')setChartLegend('incomeOutLegend',series);
  }
}
function compactMoney(v){const n=Number(v)||0;try{return new Intl.NumberFormat(undefined,{style:'currency',currency:db?.settings?.currency||'USD',notation:'compact',maximumFractionDigits:1}).format(n);}catch(e){return money(n).replace(/\.\d{2}$/,'');}}

function showAnnualChartTip(e,c,keep){const data=c._chartData||[],m=c._chartMeta;if(!data.length||!m)return;const r=c.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;let idx=0;if(m.mode==='pie'){const dx=mx-m.cx,dy=my-m.cy;if(Math.hypot(dx,dy)>m.r+8||Math.hypot(dx,dy)<4)return;let a=Math.atan2(dy,dx)+Math.PI/2;if(a<0)a+=Math.PI*2;const total=data.reduce((s,p)=>s+(+p.v||0),0);let acc=0;for(let i=0;i<data.length;i++){acc+=total?(+data[i].v||0)/total*Math.PI*2:0;if(a<=acc){idx=i;break;}}}else if(m.mode==='hbars'){idx=Math.max(0,Math.min(data.length-1,Math.floor((my-m.pad.t)/Math.max(1,m.ph)*data.length)));}else{idx=Math.max(0,Math.min(data.length-1,Math.floor((mx-m.pad.l)/Math.max(1,m.pw)*data.length)));}const p=data[idx],tip=$(c.id+'Tip');if(!tip)return;let rows='';if(m.mode==='pie'){const total=data.reduce((a,x)=>a+(+x.v||0),0);rows=`<div class="tiprow"><span>Amount</span><b>${money(p.v)}</b></div><div class="tiprow"><span>Share</span><b>${total?(p.v/total*100).toFixed(1)+'%':'—'}</b></div>`;}else if(c.id==='annualActualBillsChart'){rows=`<div class="tiprow"><span>Actual bill payments</span><b>${money(p.amount??p.v??p.a)}</b></div>`;}else if(c.id==='annualBillsChart'){rows=`<div class="tiprow"><span>Planned annual amount</span><b>${money(p.amount??p.a)}</b></div>`;}else{rows=`<div class="tiprow"><span>Income</span><b>${money(p.earned||0)}</b></div><div class="tiprow"><span>Expenses</span><b>${money(p.expenses||0)}</b></div><div class="tiprow"><span>Bills paid</span><b>${money(p.billsPaid||0)}</b></div><div class="tiprow"><span>Net cash flow</span><b class="${(p.net||0)>=0?'good':'bad'}">${money(p.net||0)}</b></div>`;if(p.recordCount===0)rows='<div class="mini">No transactions recorded for this period.</div>';}tip.innerHTML=`<strong>${esc(p.name||p.l||'Details')}</strong>${rows}`;tip.style.display='block';const tipLeft=m.mode==='hbars'?m.pad.l+Math.min(m.pw*.55,80):m.mode==='pie'?10:m.pad.l+m.pw*(idx/(data.length||1));const tipTop=m.mode==='hbars'?m.pad.t+idx*(m.ph/data.length):10;tip.style.left=Math.max(6,Math.min(m.w-220,tipLeft))+'px';tip.style.top=Math.max(6,Math.min(m.h-130,tipTop))+'px';tip._selected=keep;}
function showDebtTip(e,c,tip,keep){if(!tip||!c._chartData?.length)return;const m=c._chartMeta,r=c.getBoundingClientRect(),idx=Math.max(0,Math.min(c._chartData.length-1,Math.floor((e.clientY-r.top-m.pad.t)/Math.max(1,m.ph)*c._chartData.length))),d=c._chartData[idx];tip.innerHTML=`<strong>${esc(d.name)}</strong><div class="tiprow"><span>Outstanding balance</span><b>${money(d.amount)}</b></div><div class="tiprow"><span>APR</span><b>${(+d.apr||0).toFixed(2)}%</b></div><div class="tiprow"><span>Minimum payment</span><b>${money(d.minimum)}</b></div>`;tip.style.display='block';tip.style.left=Math.max(6,Math.min(m.w-210,m.pad.l+20))+'px';tip.style.top=Math.max(6,Math.min(m.h-110,m.pad.t+idx*(m.ph/c._chartData.length)))+'px';tip._selected=keep;}

function reportMonthLabel(p){return budgetMonthLabel(p.key||p.l)}
function showIncomeOutTip(e,c,tip,keep){
  if(!tip||!c._chartData?.length)return;
  let r=c.getBoundingClientRect(),mx=e.clientX-r.left,meta=c._chartMeta;
  let idx=Math.max(0,Math.min(c._chartData.length-1,Math.round((mx-meta.pad.l)/meta.pw*(c._chartData.length-1)))),p=c._chartData[idx];
  let out=p.projectedSpending==null?null:(p.knownBills||0)+(p.projectedSpending||0)+(p.knownTransactions||0)+(p.savings||0)+(p.investments||0);
  tip.innerHTML=`<strong>${esc(reportMonthLabel(p))}</strong><div class=\"tiprow\"><span>Income</span><b>${money(p.inc)}</b></div><div class=\"tiprow\"><span>Projected outflow</span><b>${out==null?'—':money(out)}</b></div><div class=\"tiprow\"><span>Projected expenses</span><b>${p.projectedSpending==null?'—':money(p.projectedSpending)}</b></div><div class=\"tiprow\"><span>Known bills</span><b>${money(p.knownBills)}</b></div><div class=\"tiprow\"><span>Future transactions</span><b>${money(p.knownTransactions)}</b></div><div class=\"tiprow\"><span>Savings</span><b>${money(p.savings)}</b></div><div class=\"tiprow\"><span>Investments</span><b>${money(p.investments)}</b></div><div class=\"tiprow tipsave\"><span>Income − outflow</span><b class=\"${out==null?'':(p.inc-out)>=0?'good':'bad'}\">${out==null?'—':money(p.inc-out)}</b></div>`;
  tip.style.display='block';let xx=meta.pad.l+meta.pw*(idx/(c._chartData.length-1||1));tip.style.left=Math.max(6,Math.min(meta.w-210,xx-95))+'px';tip.style.top='12px';tip._selected=keep;
}
function showProjectionTip(e,c,tip,keep){
  if(!tip||!c._chartData?.length)return;
  let r=c.getBoundingClientRect(),mx=e.clientX-r.left,meta=c._chartMeta;
  let idx=Math.max(0,Math.min(c._chartData.length-1,Math.round((mx-meta.pad.l)/meta.pw*(c._chartData.length-1)))),p=c._chartData[idx];
  tip.innerHTML=`<strong>${esc(reportMonthLabel(p))}</strong><div class="tiprow"><span>Expected income</span><b>${money(p.inc)}</b></div><div class="tiprow"><span>Projected expenses</span><b>${p.projectedSpending==null?'—':money(p.projectedSpending)}</b></div><div class="tiprow"><span>Known bills</span><b>${money(p.knownBills)}</b></div><div class="tiprow"><span>Other known bill transactions</span><b>${money(p.knownTransactions)}</b></div><div class="tiprow"><span>Savings contributions</span><b>${money(p.savings)}</b></div><div class="tiprow"><span>Investment contributions</span><b>${money(p.investments)}</b></div><div class="tiprow tipsave"><span>Monthly projected savings</span><b class="${(p.projectedSavings||0)>=0?'good':'bad'}">${p.projectedSavings==null?'—':money(p.projectedSavings)}</b></div>`;
  tip.style.display='block';let xx=meta.pad.l+meta.pw*(idx/(c._chartData.length-1||1));let yy=meta.yFor(Number(p.projectedSavings)||0);tip.style.left=Math.max(6,Math.min(meta.w-210,xx-95))+'px';tip.style.top=Math.max(6,Math.min(meta.h-150,yy-80))+'px';tip._selected=keep;
}
function showCashTip(e,c,tip,keep){if(!tip||!c._chartData)return;let r=c.getBoundingClientRect(),mx=e.clientX-r.left,meta=c._chartMeta,idx=Math.max(0,Math.min(c._chartData.length-1,Math.round((mx-meta.pad.l)/meta.pw*(c._chartData.length-1))));let p=c._chartData[idx];let rows=`<strong>${esc(p.label||p.key)}</strong><div class="tiprow"><span>Income</span><b>${money(p.inc)}</b></div><div class="tiprow"><span>Expenses</span><b>${money(p.spent)}</b></div><div class="tiprow"><span>Bills</span><b>${money(p.bills)}</b></div><div class="tiprow"><span>Savings</span><b>${money(p.savings)}</b></div><div class="tiprow"><span>Investments</span><b>${money(p.investments)}</b></div><div class="tiprow tipsave"><span>${p.available>=0?'Available':'Shortfall'}</span><b class="${p.available>=0?'good':'bad'}">${p.available>=0?'+':''}${money(p.available)}</b></div>`;tip.innerHTML=rows;let xx=meta.pad.l+meta.pw*(idx/(c._chartData.length-1||1));tip.style.display='block';tip.style.left=Math.max(6,Math.min(meta.w-186,xx-90))+'px';tip.style.top=Math.max(6,meta.yFor(p.available)-65)+'px';if(!keep)tip._hover=true}
function showSpendTip(e,c,tip,keep){if(!tip||!c._chartData?.length)return;const r=c.getBoundingClientRect(),m=c._chartMeta,mx=e.clientX-r.left,my=e.clientY-r.top,dx=mx-m.cx,dy=my-m.cy,dist=Math.hypot(dx,dy);if(dist>m.r+8||dist<4){if(!keep)tip.style.display='none';return;}let angle=Math.atan2(dy,dx)+Math.PI/2;if(angle<0)angle+=Math.PI*2;const total=c._chartData.reduce((s,p)=>s+(+p.v||0),0);let cursor=0,idx=-1;for(let i=0;i<c._chartData.length;i++){const sweep=total?(c._chartData[i].v/total)*Math.PI*2:0;if(angle>=cursor&&angle<cursor+sweep){idx=i;break;}cursor+=sweep;}if(idx<0)return;const p=c._chartData[idx],pct=total?(p.v/total)*100:0;tip.innerHTML=`<strong>${esc(p.l)}</strong><div class="tiprow"><span>Amount</span><b>${money(p.v)}</b></div><div class="tiprow"><span>Share of spending</span><b>${pct.toFixed(1)}%</b></div>`;tip.style.display='block';tip.style.left=Math.max(6,Math.min(c.clientWidth-180,mx+12))+'px';tip.style.top=Math.max(6,Math.min(c.clientHeight-78,my-12))+'px';tip._selected=keep;}



function renderDashboard(){generatePaycheckOccurrences();let m=currentMonth(),incomeTransactions=db.transactions.filter(x=>x.type==='income'&&String(x.date||'').startsWith(m)),out=dashboardOutflowsFor(m),inc=incomeTransactions.reduce((s,x)=>s+(+x.amount||0),0),spent=out.transactions.reduce((s,x)=>s+x.amount,0),saved=monthlySavingsFor(m),invested=monthlyInvestmentFor(m),plannedBills=monthlyBillTotalFor(m),avail=inc-spent-saved-invested;$('dashCards').innerHTML=[['Income',money(inc),''],['Spending',money(spent),spent>0?'':''],['Saved This Month',money(saved),saved>0?'good':''],['Invested This Month',money(invested),invested>0?'good':''],['Bills',money(plannedBills),''],['Available',money(avail),avail>=0?'good':'bad']].map(a=>`<div class="card"><div class="label">${a[0]}</div><div class="metric ${a[2]}">${a[1]}</div>${a[0]==='Bills'?'<div class="mini">unpaid bill obligations</div>':''}${a[0]==='Saved This Month'?'<div class="mini">actual savings transfers</div>':''}${a[0]==='Invested This Month'?'<div class="mini">actual investment transfers</div>':''}</div>`).join('');let cp=cashPositionHistory().map(x=>({...x,l:x.key.slice(5),v:x.available,label:new Date(x.key+'-01T12:00:00').toLocaleDateString(undefined,{month:'long',year:'numeric'})}));canvas('dashCash','line',cp);let cats={};out.entries.forEach(item=>{let k=item.category||'Other';cats[k]=(cats[k]||0)+item.amount});const rankedSpending=Object.entries(cats).sort((a,b)=>b[1]-a[1]);const spendingBreakdown=rankedSpending.length<=10?rankedSpending.map(x=>({l:x[0],v:x[1]})):[...rankedSpending.slice(0,9).map(x=>({l:x[0],v:x[1]})),{l:'Other categories',v:rankedSpending.slice(9).reduce((a,x)=>a+x[1],0)}];canvas('dashSpend','pie',spendingBreakdown);annualLegend('dashSpendLegend',spendingBreakdown);$('expenseCount').textContent=`(${out.entries.length})`;$('expenseTotal').textContent=money(spent);let expenseItems=out.transactions.filter(item=>!item.billOccurrenceId&&item.kind!=='billPayment').slice().sort((a,b)=>b.date.localeCompare(a.date)),billItems=out.transactions.filter(item=>item.billOccurrenceId||item.kind==='billPayment').slice().sort((a,b)=>b.date.localeCompare(a.date));const listGroup=(title,items,empty)=>`<div class="expenseGroup"><div class="expenseGroupTitle"><strong>${title}</strong><span class="mini">${items.length}</span></div>${items.length?items.map(item=>`<div class="listrow"><span>${esc(item.name)}<br><span class="mini">${dateText(item.date)} · ${esc(item.category)}</span></span><b>${money(item.amount)}</b></div>`).join(''): `<div class="empty" style="padding:10px 14px">${empty}</div>`}</div>`;$('expenseList').innerHTML=listGroup('Expenses',expenseItems,'No expenses recorded for this month.')+listGroup('Bills',billItems,'No paid bills recorded for this month.');let next=upcomingBillOccurrences(6);
  $('dashBills').innerHTML=next.map(o=>{
    let b=getBill(o.billId),st=occurrenceDisplayStatus(o);
    return `<div class="listrow"><button type="button" class="billDashLink" onclick="showBillOccurrence('${o.id}')"><span><b>${esc(b?.name||'Bill')}</b><br><span class="mini">Due ${dateText(o.dueDate)} · ${billStatusHtml(st)}</span></span></button><b>${money(o.expectedAmount)}</b></div>`;
  }).join('')||'<div class="empty">No unpaid upcoming bills. Add a bill or check Bills &amp; Calendar.</div>';renderDashboardSnapshot({month:m,income:inc,spending:spent,saved,invested,available:avail});}
function renderDashboardSnapshot(data){
 const root=$('dashSnapshot');if(!root)return;const {month,income,spending,saved,invested,available}=data,fmtPct=(v)=>income>0?`${Math.round(v/income*100)}%`:'—';
 const statusClass=s=>['Positive','On track'].includes(s)?'good':s==='Manageable'?'warn':s==='Needs attention'?'warn':s==='At risk'?'bad':'neutral';
 const icon=(name)=>({health:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/><path d="M3.5 12h4l2-3 3 6 2-3h6"/></svg>',goals:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',allocation:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h17"/><path d="M7 15l4-4 3 2 6-7"/></svg>',insight:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6m-5 3h4M8.5 14.5a7 7 0 1 1 7 0c-.9.6-1.5 1.5-1.5 2.5h-4c0-1-.6-1.9-1.5-2.5Z"/><path d="M12 3v2M4.9 5.9l1.4 1.4m11.4-1.4-1.4 1.4"/></svg>'}[name]||'');
 const cashFlow=income-spending-saved-invested;let cashStatus=income<=0?'Insufficient data':cashFlow<0?'Needs attention':'Positive';
 const activeDebts=db.debts.filter(d=>!['paid-off','archived'].includes(d.status)),debtBalance=activeDebts.reduce((sum,d)=>sum+debtCurrentBalance(d),0),debtPaymentsThisMonth=db.transactions.filter(t=>String(t.date||'').startsWith(month)&&t.debtId&&isOutflowTransaction(t)).reduce((sum,t)=>sum+(+t.amount||0),0),debtBurden=income>0?debtPaymentsThisMonth/income:null;
 let debtStatus='Insufficient data';if(activeDebts.length){debtStatus=debtBurden===null?'Insufficient data':debtBurden>=.45?'At risk':debtBurden>=.30?'Manageable':'On track';if(debtBalance<=0)debtStatus='On track';}
 const goals=db.goals.filter(g=>g.status!=='archived'),emergency=goals.find(g=>g.isEmergencyFund===true),goalSaved=g=>Math.max(0,goalBalance(g.id)),goalPct=g=>+g.target>0?Math.max(0,Math.min(100,goalSaved(g)/+g.target*100)):0;const hasSavedGoalSelection=Array.isArray(db.dashboardSnapshotGoalIds);let savedGoalIds=hasSavedGoalSelection?db.dashboardSnapshotGoalIds.filter(id=>goals.some(g=>String(g.id)===String(id))).slice(0,2):[];if(!hasSavedGoalSelection)savedGoalIds=[...(emergency?[emergency.id]:[]),...goals.filter(g=>g.id!==emergency?.id).map(g=>g.id)].slice(0,2);let featured=savedGoalIds.map(id=>goals.find(g=>String(g.id)===String(id))).filter(Boolean);if(!hasSavedGoalSelection&&featured.length<2)featured.push(...goals.filter(g=>!featured.some(f=>String(f.id)===String(g.id))).slice(0,2-featured.length));
 let healthItems=[{name:'Cash flow',icon:'<span class="fs-status-icon cash">↗</span>',status:cashStatus,detail:income>0?`${cashFlow>=0?'Surplus':'Shortfall'} · ${money(Math.abs(cashFlow))} this month`:'Income data unavailable'},{name:'Debt',icon:'<span class="fs-status-icon debt">▣</span>',status:debtStatus,detail:activeDebts.length?`${money(debtBalance)} balance · ${debtBurden===null?'payment burden unavailable':`${Math.round(debtBurden*100)}% of income in recorded payments`}`:'No active debt accounts'},{name:'Emergency fund',icon:'<span class="fs-status-icon fund">◉</span>',status:emergency?(goalPct(emergency)>=100?'On track':goalPct(emergency)>=25?'Manageable':'Needs attention'):'Insufficient data',detail:emergency?`${money(goalSaved(emergency))} of ${money(+emergency.target||0)} saved`:'Designate a goal as your emergency fund'}];
 const ranked=healthItems.filter(x=>x.status!=='Insufficient data'),overall=ranked.some(x=>x.status==='At risk'||x.status==='Needs attention')?'Needs attention':ranked.length?'On track':'Insufficient data';
 const alloc=[{label:'Spending',value:spending,color:'var(--blue)'},{label:'Savings',value:saved,color:'var(--green)'},{label:'Investments',value:invested,color:'var(--purple)'}];
 let insight='Add income and savings goals to see your progress here.';if(income>0){if(cashFlow<0)insight='You have a little room to review this month’s spending and contributions. Small adjustments can help get your plan back on track.';else if(emergency&&goalPct(emergency)<25)insight='You’re building your emergency fund one step at a time. Keep going—consistent contributions add up!';else if(featured.some(g=>goalPct(g)>=75))insight='You’re making strong progress toward your savings goals. Keep it up—you’re getting closer!';else if(saved>0)insight='You’re putting money toward your future this month. Keep up the steady progress toward your goals!';else if(spending/income>=.8)insight='You’re using a large share of this month’s income. Keeping an eye on spending can help leave more room for your goals.';else insight='Your cash flow is positive and you’re in a good position to keep working toward your goals. Keep it up!';}
 root.innerHTML=`<div class="fs-health"><div class="fs-head"><b><span class="fs-section-icon">${icon('health')}</span>Financial health</b><span class="healthStatus ${statusClass(overall)}">${overall}</span></div><div class="fs-health-grid">${healthItems.map(x=>`<div class="fs-health-item"><div class="fs-health-label">${x.icon}<span>${x.name}</span></div><b class="${statusClass(x.status)}">${x.status}</b><small>${x.detail}</small></div>`).join('')}</div></div><div class="fs-block"><div class="fs-head"><b><span class="fs-section-icon">${icon('goals')}</span>Savings goals</b><details class="fs-goal-picker"><summary>${goals.length} active</summary><div class="fs-goal-picker-list"><div class="mini">Choose up to two goals to show</div>${goals.map(g=>`<label><input type="checkbox" ${featured.some(f=>String(f.id)===String(g.id))?'checked':''} ${featured.length>=2&&!featured.some(f=>String(f.id)===String(g.id))?'disabled':''} onchange="setDashboardSnapshotGoal('${String(g.id).replace(/'/g, '&#39;')}',this.checked)"><span>${esc(g.name)}${g.isEmergencyFund?' · Emergency fund':''}</span></label>`).join('')}</div></details></div>${featured.length?featured.map(g=>`<div class="fs-goal"><div class="fs-goal-label"><span>${esc(g.name)}${g.isEmergencyFund?' · Emergency fund':''}</span><b>${Math.round(goalPct(g))}%</b></div><div class="fs-progress"><i style="width:${goalPct(g)}%"></i></div><small>${money(goalSaved(g))} of ${money(+g.target||0)}</small></div>`).join(''):'<div class="mini">Create a goal in Savings Goals to track progress here.</div>'}</div><div class="fs-block"><div class="fs-head"><b><span class="fs-section-icon">${icon('allocation')}</span>Monthly allocation</b><span class="mini">of income</span></div>${alloc.map(a=>`<div class="fs-alloc"><span><i style="background:${a.color}"></i>${a.label}</span><div class="fs-progress"><i style="width:${income>0?Math.min(100,a.value/income*100):0}%;background:${a.color}"></i></div><b>${fmtPct(a.value)}</b></div>`).join('')}<div class="mini fs-alloc-note">${income>0?`Income: ${money(income)} · recorded activity.`:'Income not recorded for this month.'}</div></div><div class="fs-insight"><div class="fs-insight-title"><span class="fs-section-icon">${icon('insight')}</span><b>Quick insight</b></div><div>${esc(insight)}</div></div>`;
}
function setDashboardSnapshotGoal(goalId,checked){const active=db.goals.filter(g=>g.status!=='archived');let ids=Array.isArray(db.dashboardSnapshotGoalIds)?db.dashboardSnapshotGoalIds.filter(id=>active.some(g=>String(g.id)===String(id))):[];if(!ids.length){const emergency=active.find(g=>g.isEmergencyFund===true);ids=[...(emergency?[emergency.id]:[]),...active.filter(g=>g.id!==emergency?.id).map(g=>g.id)].slice(0,2);}if(checked){if(!ids.some(id=>String(id)===String(goalId))){if(ids.length>=2)return alert('Choose up to two savings goals for the Dashboard.');ids.push(goalId);}}else ids=ids.filter(id=>String(id)!==String(goalId));db.dashboardSnapshotGoalIds=ids;save();renderDashboard();const picker=$('dashSnapshot')?.querySelector('.fs-goal-picker');if(picker)picker.open=true;}

function allocationTargetExists(a){
  if(!a?.targetId||a.type==='other')return true;
  if(a.type==='category')return db.categories.includes(String(a.targetId));
  if(a.type==='bill'){let o=getOccurrence(a.targetId);return !!o&&!!getBill(o.billId)}
  if(a.type==='debt')return !!db.debts.find(x=>x.id===a.targetId);
  if(a.type==='savings')return !!db.goals.find(x=>x.id===a.targetId);
  if(a.type==='investment')return !!db.investments.find(x=>x.id===a.targetId);
  return true;
}
function allocationLabel(a){let base=a.label||({bill:'Bill',category:'Category',debt:'Debt',savings:'Savings',investment:'Investment',other:'Other'}[a.type]||'Other');if(a?.targetId&&!allocationTargetExists(a))return `${base} — Target no longer exists`;return base}
function monthlyAllocation(){
  const key=currentMonth();
  const occurrences=db.paycheckOccurrences.filter(o=>String(o.scheduledDate||'').startsWith(key)&&paycheckOccurrenceCountsAsPlanned(o));
  const expected=occurrences.reduce((s,o)=>s+(+o.expectedAmount||0),0);
  const allocs=db.assignments.filter(a=>{let o=getPaycheckOccurrence(a.paycheckOccurrenceId);return o&&String(o.scheduledDate||'').startsWith(key)&&paycheckOccurrenceCountsAsPlanned(o)});
  const plannedBills=allocs.filter(a=>a.type==='bill').reduce((s,a)=>s+(+a.amount||0),0);
  const category=allocs.filter(a=>a.type==='category').reduce((s,a)=>s+(+a.amount||0),0);
  const debt=allocs.filter(a=>a.type==='debt').reduce((s,a)=>s+(+a.amount||0),0);
  const savings=allocs.filter(a=>a.type==='savings').reduce((s,a)=>s+(+a.amount||0),0);
  const investment=allocs.filter(a=>a.type==='investment').reduce((s,a)=>s+(+a.amount||0),0);
  const other=allocs.filter(a=>a.type==='other').reduce((s,a)=>s+(+a.amount||0),0);
  const total=plannedBills+category+debt+savings+investment+other;
  return {expected,plannedBills,category,debt,savings,investment,other,unassigned:expected-total};
}

function paycheckStatusPill(o){let st=paycheckOccurrenceStatus(o);return `<span class="billStatus paycheckStatus ${occurrenceStatusClass(st)}">${st}</span>`}
function renderPlan(){
  generatePaycheckOccurrences();
  const month=currentMonth(),occ=db.paycheckOccurrences.filter(o=>String(o.scheduledDate||'').startsWith(month)&&(paycheckScheduleActive(o)||paycheckOccurrenceHasActualIncome(o))).sort((a,b)=>a.scheduledDate.localeCompare(b.scheduledDate));
  const awaiting=db.paycheckOccurrences.filter(o=>paycheckOccurrenceStatus(o)==='Awaiting Deposit'&&paycheckScheduleActive(o)).sort((a,b)=>a.scheduledDate.localeCompare(b.scheduledDate));
  const ma=monthlyAllocation();
  $('planCards').innerHTML=[['Expected this month',money(ma.expected)],['Allocated this month',money(Math.max(0,ma.expected-ma.unassigned))],['Unassigned',money(ma.unassigned)]].map(a=>`<div class="card"><div class="label">${a[0]}</div><div class="metric ${a[0]==='Unassigned'&&a[1].startsWith('-')?'bad':''}">${a[1]}</div></div>`).join('');
  $('paychecks').innerHTML=`${awaiting.length?`<div class="notice section"><b>Awaiting deposit</b><div class="mini">Confirm each deposit when the money actually arrives. Budget OS will then create the Income transaction.</div>${awaiting.map(o=>{let p=getPaycheckSchedule(o.paycheckId);return `<div class="listrow"><span><b>${esc(p?.name||'Paycheck')}</b><br><span class="mini">Scheduled ${dateText(o.scheduledDate)} · Expected ${money(o.expectedAmount)}</span></span><div class="billRowActions"><button class="btn small primary" onclick="openDepositModal('${o.id}')">Confirm Deposit</button><button class="btn small" onclick="markPaycheckNotDeposited('${o.id}')">Not Deposited</button></div></div>`}).join('')}</div>`:''}<div class="sectionhead"><h3 style="margin:0">This month</h3><button class="btn small" onclick="openModal('paycheck')">+ Schedule</button></div>${occ.map(o=>{let p=getPaycheckSchedule(o.paycheckId);return `<div class="listrow"><span><b>${esc(p?.name||'Paycheck')}</b><br><span class="mini">${dateText(o.scheduledDate)} · ${paycheckFrequencyLabel(p?.frequency)}</span></span><div class="billRowActions">${paycheckStatusPill(o)}<b>${money(paycheckOccurrenceAmount(o))}</b><button class="btn small" onclick="showPaycheckOccurrence('${o.id}')">View</button></div></div>`}).join('')||'<div class="empty">No paycheck occurrences for this month.</div>'}<div class="sectionhead section"><h3 style="margin:0">Schedules</h3><button class="btn small primary" onclick="openModal('paycheck')">+ Paycheck Schedule</button></div>${db.paychecks.filter(p=>p.active!==false).sort((a,b)=>String(a.name).localeCompare(String(b.name))).map(p=>{let next=db.paycheckOccurrences.filter(o=>o.paycheckId===p.id&&p.active!==false&&o.scheduledDate>=localDateKey(today)&&o.status!=='cancelled'&&!o.transactionId).sort((a,b)=>a.scheduledDate.localeCompare(b.scheduledDate))[0];return `<div class="listrow"><span><b>${esc(p.name)}</b><br><span class="mini">${paycheckFrequencyLabel(p.frequency)} · ${money(p.expectedAmount)} · Next ${next?dateText(next.scheduledDate):'—'}</span></span><div class="billRowActions"><button class="btn small" onclick="openPaycheckEdit('${p.id}')">Edit</button><button class="btn small" onclick="showPaycheckSchedule('${p.id}')">Details</button><button class="btn small danger" onclick="deactivatePaycheck('${p.id}')">Deactivate</button></div></div>`}).join('')||'<div class="empty">No active paycheck schedules.</div>'}<div class="sectionhead section"><h3 style="margin:0">Deactivated schedules</h3></div>${db.paychecks.filter(p=>p.active===false).sort((a,b)=>String(a.name).localeCompare(String(b.name))).map(p=>`<div class="listrow"><span><b>${esc(p.name)}</b><br><span class="mini">${paycheckFrequencyLabel(p.frequency)} · ${money(p.expectedAmount)} · Inactive</span></span><div class="billRowActions"><button class="btn small" onclick="openPaycheckEdit('${p.id}')">Reactivate / Edit</button><button class="btn small" onclick="showPaycheckSchedule('${p.id}')">History</button></div></div>`).join('')||'<div class="empty">No deactivated schedules.</div>'}`;
  $('allocation').innerHTML=`<div class="listrow"><span>Expected income</span><b>${money(ma.expected)}</b></div><div class="listrow"><span>Planned bills</span><b>${money(ma.plannedBills)}</b></div><div class="listrow"><span>Budget categories</span><b>${money(ma.category)}</b></div><div class="listrow"><span>Debt</span><b>${money(ma.debt)}</b></div><div class="listrow"><span>Savings</span><b>${money(ma.savings)}</b></div><div class="listrow"><span>Investments</span><b>${money(ma.investment)}</b></div><div class="listrow"><span>Other allocations</span><b>${money(ma.other)}</b></div><div class="listrow"><span><b>Unassigned</b></span><b>${money(ma.unassigned)}</b></div>`;
  const rows=db.assignments.slice().sort((a,b)=>String(a.paycheckOccurrenceId||'').localeCompare(String(b.paycheckOccurrenceId||''))).map(a=>{let o=getPaycheckOccurrence(a.paycheckOccurrenceId),p=o&&getPaycheckSchedule(o.paycheckId);return `<tr><td>${p?esc(p.name):'Unknown'}</td><td>${o?dateText(o.scheduledDate):'Unknown'}</td><td>${esc(allocationLabel(a))}</td><td>${money(a.amount)}</td><td>${esc(a.note||'')}</td><td><div class="billRowActions"><button type="button" class="btn small" onclick="openAllocationEdit('${a.id}')">Edit</button><button class="btn small danger" onclick="removeAllocation('${a.id}')">Delete</button></div></td></tr>`}).join('');
  $('assignments').innerHTML=rows||'<tr><td colspan="6" class="empty">No allocations yet.</td></tr>';
}
function openAllocationEditor(preset=null){
  const edit=!!preset, a0=preset||{};
  let title=edit?'Edit paycheck allocation':'Assign paycheck money';
  if(!edit)generatePaycheckOccurrences();
  const occs=db.paycheckOccurrences.filter(o=>(o.scheduledDate>=localDateKey(today)||o.id===a0.paycheckOccurrenceId)&&o.status!=='cancelled'&&o.status!=='not-deposited'&&(paycheckScheduleActive(o)||o.id===a0.paycheckOccurrenceId)).sort((a,b)=>a.scheduledDate.localeCompare(b.scheduledDate)).slice(0,80);
  const opts=occs.map(o=>`<option value="${o.id}" ${o.id===a0.paycheckOccurrenceId?'selected':''}>${esc(getPaycheckSchedule(o.paycheckId)?.name||'Paycheck')} — ${dateText(o.scheduledDate)} — ${money(paycheckOccurrenceAmount(o))}</option>`).join('');
  const body=`<div class="formgrid"><div class="field"><label>Paycheck occurrence</label><select name="paycheckOccurrenceId">${opts}</select></div><div class="full mini">Choose the paycheck occurrence; the internal ID is never shown.</div>${s('Allocation type','type',['bill','category','debt','savings',...(edit&&a0.type==='investment'?['investment']:[]),'other'],a0.type||'other')}<div class="field" data-allocation-target-wrap><label>Target</label><select name="targetId"></select></div>${f('Label','label','text',a0.label||'','required placeholder="Rent"')}${f('Amount','amount','number',a0.amount??'','required min="0.01" step=".01"')}${f('Note','note','text',a0.note||'')}<div class="full mini">Allocations are planning only. They do not pay bills, reduce debt, add savings, or add investments.</div><div class="full"><button class="btn primary" type="submit">${edit?'Save Changes':'Assign'}</button></div></div>`;
  $('modalTitle').textContent=title;
  $('modalForm').innerHTML=body;
  $('modalForm').dataset.type=edit?'assignmentEdit':'assignment';
  if(edit)$('modalForm').dataset.editId=a0.id;
  $('modalForm').dataset.targetId=String(a0.targetId||'');
  const form=$('modalForm'),typeEl=form.querySelector('[name="type"]'),targetEl=form.querySelector('[name="targetId"]'),labelEl=form.querySelector('[name="label"]'),targetWrap=form.querySelector('[data-allocation-target-wrap]');
  const targetOptions=()=>{
    const v=typeEl?.value||'other', selected=String(form.dataset.targetId||'');
    let options='';
    if(v==='bill'){
      ensureBillOccurrences();
      const selectedOcc=selected?getOccurrence(selected):null;
      const selectedBill=selectedOcc?getBill(selectedOcc.billId):null;
      const candidates=db.billOccurrences.filter(o=>billOccurrenceCountsAsObligation(o)||o.id===selected).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
      options=candidates.slice(0,150).map(o=>{
        let b=getBill(o.billId),suffix='';
        if(o.id===selected && b?.active===false)suffix=' — Inactive bill';
        else if(o.id===selected && occurrenceDisplayStatus(o)==='paid')suffix=' — Paid';
        return `<option value="${o.id}">${esc(b?.name||'Bill')} — ${dateText(o.dueDate)} — ${money(o.expectedAmount)}${suffix}</option>`;
      }).join('');
      if(selected && (!selectedOcc||!selectedBill))options=`<option value="${esc(selected)}">${esc(a0.label||'Bill')} — Target no longer exists</option>`+options;
    }else if(v==='category'){
      options=db.categories.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    }else if(v==='debt'){
      options=db.debts.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('');
    }else if(v==='savings'){
      options=db.goals.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('');
    }else if(v==='investment'&&selected){
      options=`<option value="${esc(selected)}">${esc(a0.label||'Investment allocation')} — Legacy allocation</option>`;
    }
    if(!targetEl)return;
    if(v!=='bill' && selected && !allocationTargetExists({...a0,type:v,targetId:selected}) && ![...targetEl.options].some(x=>x.value===selected)){
      options=`<option value="${esc(selected)}">${esc(a0.label||'Target')} — Target no longer exists</option>`+options;
    }
    targetEl.innerHTML=options||'<option value="">No targets available</option>';
    if(selected && [...targetEl.options].some(x=>x.value===selected))targetEl.value=selected;
    targetWrap.style.display=v==='other'?'none':'';
    targetEl.disabled=v==='other'||!options;
    labelEl.closest('.field').style.display=v==='other'||v==='category'?'':'none';
    if(v==='category'&&options)labelEl.value=targetEl.options[targetEl.selectedIndex]?.text||'';
    else if(v!=='other'&&options)labelEl.value=targetEl.options[targetEl.selectedIndex]?.text||'';
    else if(v==='other'&&!labelEl.value)labelEl.value='Other';
  };
  typeEl?.addEventListener('change',targetOptions);
  targetEl?.addEventListener('change',()=>{if(typeEl.value!=='other'&&targetEl.selectedOptions[0])labelEl.value=targetEl.selectedOptions[0].text});
  targetOptions();
  $('modalBack').classList.add('show');
}
function openAllocationEdit(id){
  const a=db.assignments.find(x=>x.id===id);
  if(!a)return alert('That allocation no longer exists.');
  openAllocationEditor(a);
}
window.openAllocationEdit=openAllocationEdit;
function removeAllocation(id){let a=db.assignments.find(x=>x.id===id);if(!a)return;let o=getPaycheckOccurrence(a.paycheckOccurrenceId);if(o?.allocationIds)o.allocationIds=o.allocationIds.filter(x=>x!==id);db.assignments=db.assignments.filter(x=>x.id!==id);save();renderPlan()}

function renderTransactions(){
 generatePaycheckOccurrences();
 ensureBillOccurrences();
 let q=($('txSearch').value||'').trim().toLowerCase(),f=$('txFilter').value;
 let rows=db.transactions.filter(t=>{
   if(f!=='all'&&t.type!==f)return false;
   let bo=t.billOccurrenceId?getOccurrence(t.billOccurrenceId):null,b=bo?getBill(bo.billId):null,p=t.paycheckOccurrenceId?getPaycheckOccurrence(t.paycheckOccurrenceId):null,goal=t.goalId?(db.goals.find(g=>g.id===t.goalId)||db.deletedGoalHistory.find(g=>g.id===t.goalId)):null;
   let hay=[t.description,t.note,t.category,t.account,t.type,transactionTypeLabel(t),t.date,String(t.amount),b?.name,getPaycheckSchedule(p?.paycheckId)?.name,goal?.name].filter(Boolean).join(' ').toLowerCase();
   return !q||hay.includes(q);
 }).sort((a,b)=>String(b.date).localeCompare(String(a.date))||String(b.id).localeCompare(String(a.id)));
 $('txTable').innerHTML=rows.map(t=>{
   let bo=t.billOccurrenceId?getOccurrence(t.billOccurrenceId):null,b=bo?getBill(bo.billId):null,p=t.paycheckOccurrenceId?getPaycheckOccurrence(t.paycheckOccurrenceId):null;
   let sign=t.type==='income'?'+':(t.type==='savings'||t.type==='investment'?'→':'-');
   return `<tr><td data-label="Date">${dateText(t.date)}</td><td data-label="Description"><button type="button" class="linkbtn" onclick="showTransaction('${t.id}')"><b>${esc(transactionDescription(t))}</b></button><br><span class="mini">${esc(t.note||'')}</span></td><td data-label="Type"><span class="pill txType ${transactionTypeClass(t)}">${transactionTypeLabel(t)}</span></td><td data-label="Category">${esc(t.category||'—')}</td><td data-label="Account">${esc(t.account||'—')}</td><td data-label="Amount" class="${t.type==='income'?'good':(t.type==='savings'||t.type==='investment'?'':'bad')}">${sign} ${money(t.amount)}</td><td data-label="Source">${[b?`<span class="pill">Bill: ${esc(b.name)}</span>`:'',p?`<span class="pill">Paycheck: ${esc(p.name||'Paycheck')}</span>`:'',t.type==='savings'&&t.goalId?`<span class="pill">${esc(db.goals.find(g=>g.id===t.goalId)?.name||deletedGoalLabel(t.goalId))}</span>`:'',t.debtId?(db.debts.find(d=>String(d.id)===String(t.debtId))?`<span class="pill">Debt: ${esc(db.debts.find(d=>String(d.id)===String(t.debtId)).name)}</span>`:`<span class="pill">Debt: Historical</span>`):''].filter(Boolean).join(' ')||'—'}</td><td data-label="Actions"><div class="billRowActions"><button class="btn small" onclick="showTransaction('${t.id}')">View</button><button class="btn small" onclick="openTransactionEdit('${t.id}')">Edit</button><button class="btn small danger" onclick="deleteTransaction('${t.id}')">Delete</button></div></td></tr>`;
 }).join('')||'<tr><td colspan="8" class="empty">No transactions.</td></tr>';
}
function syncBillOccurrence(occId){
 let o=getOccurrence(occId);if(!o)return;
 o.payments=(o.payments||[]).filter(id=>db.transactions.some(t=>t.id===id&&t.type==='bill'&&t.billOccurrenceId===occId));
 let payments=occurrencePayments(o),paid=payments.reduce((s,t)=>s+(+t.amount||0),0);
 o.transactionId=o.payments[0]||null;
 o.paidDate=payments.length?payments.slice().sort((a,b)=>String(a.date).localeCompare(String(b.date))).at(-1).date:null;
 o.actualAmount=paid||null;
 o.status=occurrenceDisplayStatus(o);
}
function unlinkTransactionFromBill(t){
 if(!t?.billOccurrenceId)return;
 let occId=t.billOccurrenceId,o=getOccurrence(occId);
 if(o){o.payments=(o.payments||[]).filter(id=>id!==t.id);if(o.transactionId===t.id)o.transactionId=o.payments[0]||null;}
 delete t.billOccurrenceId;
 if(o)syncBillOccurrence(occId);
}
function linkTransactionToBill(txId,occId){
 let t=db.transactions.find(x=>x.id===txId),o=getOccurrence(occId),b=o&&getBill(o.billId);
 if(!t||!o||!b)return false;
 if(t.type==='income'){alert('Income transactions cannot be linked to bills.');return false}
 if(t.billOccurrenceId&&t.billOccurrenceId!==occId){alert('This transaction is already linked to another bill.');return false}
 if(occurrenceDisplayStatus(o)==='paid'&&!o.payments?.includes(txId)){alert('This bill occurrence is already fully paid.');return false}
 t.type='bill';t.billOccurrenceId=occId;o.payments=o.payments||[];if(!o.payments.includes(txId))o.payments.push(txId);syncBillOccurrence(occId);save();render();return true;
}
function openLinkBill(txId){let t=db.transactions.find(x=>x.id===txId);if(!t||t.type==='income')return;ensureBillOccurrences();let options=unpaidBillOptions().filter(o=>!o.payments?.includes(txId));$('modalTitle').textContent='Link transaction to bill';$('modalForm').innerHTML=`<div class="formgrid"><div class="field full"><label>Bill occurrence</label><select name="billOccurrenceId" required><option value="">Select a bill</option>${options.map(o=>{let b=getBill(o.billId);return `<option value="${o.id}">${esc(b?.name||'Bill')} — Due ${dateText(o.dueDate)} — ${money(o.expectedAmount)}</option>`}).join('')}</select></div><div class="full mini">This converts the transaction to a Bill transaction and links it to the selected bill payment. It does not create another transaction.</div><div class="full"><button class="btn primary" type="submit">Link Bill</button></div></div>`;$('modalForm').dataset.type='linkBill';$('modalForm').dataset.txId=txId;$('modalBack').classList.add('show')}
function showTransaction(id){let t=db.transactions.find(x=>x.id===id);if(!t)return;let bo=t.billOccurrenceId?getOccurrence(t.billOccurrenceId):null,b=bo?getBill(bo.billId):null,p=t.paycheckOccurrenceId?getPaycheckOccurrence(t.paycheckOccurrenceId):null;let goal=t.type==='savings'&&t.goalId?db.goals.find(g=>g.id===t.goalId):null;let debt=t.debtId?db.debts.find(d=>String(d.id)===String(t.debtId)):null;let source=b?`<div class="listrow"><span>Bill</span><b>${esc(b.name)}</b></div><div class="listrow"><span>Expected</span><b>${money(bo.expectedAmount)}</b></div><div class="listrow"><span>Status</span><b>${billStatusHtml(occurrenceDisplayStatus(bo))}</b></div>`:p?`<div class="listrow"><span>Paycheck</span><b>${esc(p.name||'Paycheck')}</b></div>`:goal?`<div class="listrow"><span>Savings goal</span><b>${esc(goal.name)}</b></div>`:t.type==='savings'&&t.goalId?`<div class="notice">Savings goal: ${esc(deletedGoalLabel(t.goalId))}. The historical transaction remains intact.</div>`:'<div class="mini">Manual transaction</div>';$('modalTitle').textContent='Transaction details';$('modalForm').innerHTML=`<div class="section"><div class="billDetailHero"><div><div class="label">${transactionTypeLabel(t)}</div><h2 style="margin:3px 0">${esc(transactionDescription(t))}</h2><div class="mini">${dateText(t.date)}</div></div><div class="billDetailAmount">${t.type==='income'?'+':(t.type==='savings'||t.type==='investment'?'→':'-')}${money(t.amount)}</div></div><div class="section">${[['Category',t.category||'—'],['Account',t.account||'—'],['Notes',t.note||'—']].map(x=>`<div class="listrow"><span>${x[0]}</span><b>${esc(x[1])}</b></div>`).join('')}</div>${source}${debt?`<div class="listrow"><span>Debt</span><b>${esc(debt.name)}</b></div>`:t.debtId?`<div class="notice">Debt relationship: historical debt record no longer exists.</div>`:''}</div><div class="toolbar"><button type="button" class="btn primary" onclick="closeModal();openTransactionEdit('${t.id}')">Edit</button>${t.type!=='income'&&!t.billOccurrenceId?`<button type="button" class="btn" onclick="closeModal();openLinkBill('${t.id}')">Link to Bill</button>`:''}${bo?`<button type="button" class="btn" onclick="closeModal();showBillOccurrence('${bo.id}')">View Bill</button>`:''}<button type="button" class="btn danger" onclick="closeModal();deleteTransaction('${t.id}')">Delete</button><button type="button" class="btn" onclick="closeModal()">Close</button></div>`;$('modalForm').dataset.type='detail';$('modalBack').classList.add('show')}
function showBillTransaction(id){if(id)showTransaction(id)}
function openTransactionEdit(id){let t=db.transactions.find(x=>x.id===id);if(!t)return;let bo=t.billOccurrenceId?getOccurrence(t.billOccurrenceId):null;openModal('transactionEdit',t);if(bo)$('modalForm').querySelector('[name="billOccurrenceId"]')?.setAttribute('disabled','disabled')}
function linkTransactionToPaycheck(t,occId){
  if(!t||t.type!=='income')return false;
  const o=getPaycheckOccurrence(occId);if(!o)return false;
  if(o.transactionId&&o.transactionId!==t.id){alert('That paycheck occurrence already has an Income transaction. Edit that transaction instead.');return false}
  if(t.paycheckOccurrenceId&&t.paycheckOccurrenceId!==occId)unlinkTransactionFromPaycheck(t);
  t.paycheckOccurrenceId=o.id;o.transactionId=t.id;o.actualDate=t.date;o.actualAmount=+t.amount||0;o.status='deposited';return true;
}
function unlinkTransactionFromPaycheck(t){
  if(!t?.paycheckOccurrenceId)return;
  const o=getPaycheckOccurrence(t.paycheckOccurrenceId);if(o){o.transactionId=null;o.actualDate=null;o.actualAmount=null;o.status=o.scheduledDate>localDateKey(today)?'scheduled':(o.scheduledDate===localDateKey(today)?'awaiting':'historical');}
  delete t.paycheckOccurrenceId;
}
function syncPaycheckOccurrenceFromTransaction(t){
  if(!t?.paycheckOccurrenceId)return;
  const o=getPaycheckOccurrence(t.paycheckOccurrenceId);if(!o)return;
  o.transactionId=t.id;o.actualDate=t.date;o.actualAmount=+t.amount||0;o.status='deposited';
}
function deleteTransaction(id){let t=db.transactions.find(x=>x.id===id);if(!t)return;if(!confirm('Delete this transaction? Linked bill or paycheck records will be recalculated.'))return;let occId=t.billOccurrenceId;if(t.paycheckOccurrenceId)unlinkTransactionFromPaycheck(t);db.transactions=db.transactions.filter(x=>x.id!==id);if(occId){let o=getOccurrence(occId);if(o){o.payments=(o.payments||[]).filter(x=>x!==id);if(o.transactionId===id)o.transactionId=o.payments[0]||null;syncBillOccurrence(occId)}}recalculateDebtLedgers();save();render()}


function openPaycheckEdit(id){let p=getPaycheckSchedule(id);if(p)openModal('paycheckEdit',p)}
function deactivatePaycheck(id){let p=getPaycheckSchedule(id);if(!p)return;if(confirm(`Deactivate ${p.name}? Existing deposits and past occurrences will remain in history, but future scheduled paychecks will be removed.`)){p.active=false;const todayKey=localDateKey(today);const removeIds=new Set(db.paycheckOccurrences.filter(o=>o.paycheckId===id&&!o.transactionId&&o.scheduledDate>=todayKey).map(o=>o.id));db.assignments=db.assignments.filter(a=>!removeIds.has(a.paycheckOccurrenceId));db.paycheckOccurrences=db.paycheckOccurrences.filter(o=>!removeIds.has(o.id));save();render()}}
function showPaycheckSchedule(id){let p=getPaycheckSchedule(id);if(!p)return;let next=db.paycheckOccurrences.filter(o=>o.paycheckId===id).sort((a,b)=>a.scheduledDate.localeCompare(b.scheduledDate)).slice(0,12);$('modalTitle').textContent='Paycheck schedule';$('modalForm').innerHTML=`<div class="section"><div class="billDetailHero"><div><div class="label">${paycheckFrequencyLabel(p.frequency)}</div><h2 style="margin:3px 0">${esc(p.name)}</h2><div class="mini">Expected ${money(p.expectedAmount)} · First ${dateText(p.firstDate)}</div></div></div>${next.map(o=>`<div class="listrow"><span><b>${dateText(o.scheduledDate)}</b><br><span class="mini">${paycheckOccurrenceStatus(o)} · ${money(paycheckOccurrenceAmount(o))}</span></span><button type="button" class="btn small" onclick="closeModal();showPaycheckOccurrence('${o.id}')">View</button></div>`).join('')}</div><div class="toolbar"><button type="button" class="btn primary" onclick="closeModal();openPaycheckEdit('${p.id}')">Edit Schedule</button><button type="button" class="btn" onclick="closeModal()">Close</button></div>`;$('modalForm').dataset.type='detail';$('modalBack').classList.add('show')}
function showPaycheckOccurrence(id){let o=getPaycheckOccurrence(id),p=o&&getPaycheckSchedule(o.paycheckId);if(!o||!p)return;let tx=occurrenceTransaction(o),st=paycheckOccurrenceStatus(o);$('modalTitle').textContent='Paycheck occurrence';$('modalForm').innerHTML=`<div class="section"><div class="billDetailHero"><div><div class="label">${paycheckFrequencyLabel(p.frequency)}</div><h2 style="margin:3px 0">${esc(p.name)}</h2><div class="mini">Scheduled ${dateText(o.scheduledDate)} · Expected ${money(o.expectedAmount)}</div></div><div style="text-align:right">${paycheckStatusPill(o)}<div class="billDetailAmount">${money(paycheckOccurrenceAmount(o))}</div></div></div>${tx?`<div class="listrow"><span>Actual deposit</span><b>${dateText(tx.date)} · ${money(tx.amount)}</b></div>`:''}${o.allocationIds?.length?`<div class="section"><h3>Allocations</h3>${o.allocationIds.map(id=>db.assignments.find(a=>a.id===id)).filter(Boolean).map(a=>`<div class="listrow"><span>${esc(allocationLabel(a))}</span><b>${money(a.amount)}</b></div>`).join('')}</div>`:''}</div><div class="toolbar">${st==='Awaiting Deposit'?`<button type="button" class="btn primary" onclick="closeModal();openDepositModal('${o.id}')">Confirm Deposit</button><button type="button" class="btn" onclick="closeModal();markPaycheckNotDeposited('${o.id}')">Not Deposited</button>`:''}${st==='Not Deposited'?`<button type="button" class="btn" onclick="closeModal();resetPaycheckNotDeposited('${o.id}')">Restore Awaiting Deposit</button>`:''}${tx?`<button type="button" class="btn" onclick="closeModal();openTransactionEdit('${tx.id}')">Edit Income</button><button type="button" class="btn danger" onclick="closeModal();resetPaycheckDeposit('${o.id}')">Undo Deposit</button>`:''}<button type="button" class="btn" onclick="closeModal();openOccurrenceEdit('${o.id}')">Edit Occurrence</button><button type="button" class="btn" onclick="closeModal()">Close</button></div>`;$('modalForm').dataset.type='detail';$('modalBack').classList.add('show')}
function openOccurrenceEdit(id){let o=getPaycheckOccurrence(id),p=o&&getPaycheckSchedule(o.paycheckId);if(!o||!p)return;$('modalTitle').textContent='Edit paycheck occurrence';$('modalForm').innerHTML=`<div class="formgrid">${f('Scheduled date','scheduledDate','date',o.scheduledDate,'required')}${f('Expected amount','expectedAmount','number',o.expectedAmount,'required min="0.01" step=".01"')}<div class="full"><div class="notice">This changes only this occurrence. The recurring schedule is not changed.</div></div><div class="full"><button class="btn primary" type="submit">Save Occurrence</button></div></div>`;$('modalForm').dataset.type='occurrenceEdit';$('modalForm').dataset.occurrenceId=id;$('modalBack').classList.add('show')}
function openDepositModal(id){let o=getPaycheckOccurrence(id),p=o&&getPaycheckSchedule(o.paycheckId);if(!o||!p)return;if(paycheckOccurrenceStatus(o)==='Deposited'){showPaycheckOccurrence(id);return}$('modalTitle').textContent='Confirm paycheck deposit';$('modalForm').innerHTML=`<div class="formgrid">${f('Paycheck','paycheckName','text',p.name,'readonly')}${f('Scheduled date','scheduledDate','date',o.scheduledDate,'readonly')}${f('Actual deposit date','actualDate','date',localDateKey(today),'required')}${f('Actual amount','actualAmount','number',o.expectedAmount,'required min="0.01" step=".01"')}${f('Account (optional)','account','text','','placeholder="Checking"')}${f('Note','note')}<div class="full"><div class="notice">This confirms money actually arrived and creates one Income transaction. Planned paychecks never create transactions automatically.</div></div><div class="full"><button class="btn primary" type="submit">Confirm Deposit</button></div></div>`;$('modalForm').dataset.type='deposit';$('modalForm').dataset.occurrenceId=id;$('modalBack').classList.add('show')}
function markPaycheckNotDeposited(id){let o=getPaycheckOccurrence(id);if(!o)return;if(!confirm('Mark this paycheck as not deposited? No Income transaction will be created.'))return;if(o.transactionId){let tx=db.transactions.find(t=>t.id===o.transactionId);if(tx)db.transactions=db.transactions.filter(t=>t.id!==tx.id);o.transactionId=null;o.actualDate=null;o.actualAmount=null;}o.status='not-deposited';save();render()}
function resetPaycheckNotDeposited(id){let o=getPaycheckOccurrence(id);if(!o)return;o.status=o.scheduledDate>localDateKey(today)?'scheduled':(o.scheduledDate===localDateKey(today)?'awaiting':'historical');save();render()}
function resetPaycheckDeposit(id){let o=getPaycheckOccurrence(id);if(!o)return;let tx=occurrenceTransaction(o);if(tx)db.transactions=db.transactions.filter(t=>t.id!==tx.id);o.transactionId=null;o.actualDate=null;o.actualAmount=null;o.status=o.scheduledDate>localDateKey(today)?'scheduled':(o.scheduledDate===localDateKey(today)?'awaiting':'historical');save();render()}

let billCalendarDate=new Date(today.getFullYear(),today.getMonth(),1);window.billMonthListView='calendar';
function billMonthKey(){return `${billCalendarDate.getFullYear()}-${String(billCalendarDate.getMonth()+1).padStart(2,'0')}`}
function changeBillMonth(delta){billCalendarDate.setMonth(billCalendarDate.getMonth()+delta);renderBills()}
function goBillToday(){billCalendarDate=new Date(today.getFullYear(),today.getMonth(),1);renderBills()}
function billStatusHtml(status){let label={paid:'Paid',partial:'Partially Paid',overdue:'Overdue',due:'Due',upcoming:'Upcoming'}[status]||status;return `<span class="billStatus ${status}">${label}</span>`}
function showBillOccurrence(id){ensureBillOccurrences();let o=getOccurrence(id),b=o&&getBill(o.billId);if(!o||!b)return;let status=occurrenceDisplayStatus(o),payments=occurrencePayments(o),paid=occurrencePaidAmount(o);$('billDetailsPanel').style.display='block';$('billDetailsPanel').innerHTML=`<div class="sectionhead"><div><h2>${esc(b.name)}</h2><div class="mini">${esc(b.category)} · ${esc(b.billType)} · ${esc(b.amountType)} amount</div></div><button class="btn small" onclick="$('billDetailsPanel').style.display='none'">Close</button></div><div class="billDetailHero"><div><div class="label">Due date</div><div><b>${dateText(o.dueDate)}</b></div><div class="mini">Expected ${money(o.expectedAmount)} · Paid ${money(paid)}</div></div><div style="text-align:right">${billStatusHtml(status)}<div class="billDetailAmount">${money((o.actualAmount??paid)||o.expectedAmount)}</div></div></div><div class="toolbar section"><button class="btn" onclick="openBillEdit('${b.id}')">Edit Bill</button>${status==='paid'?`<button class="btn" onclick="showBillTransaction('${payments[0]?.id||o.transactionId||''}')">View Transaction</button>`:`<button class="btn primary" onclick="openPaymentModal('${o.id}')">${status==='partial'?'Add Payment':'Mark Paid'}</button>`}</div>${payments.length?`<div class="section"><h3>Payment history</h3>${payments.map(t=>`<div class="billHistoryItem"><div class="listrow"><span><b>${dateText(t.date)}</b><br><span class="mini">${esc(t.account||'No account')} · ${esc(t.category||b.category)}</span></span><b>${money(t.amount)}</b></div></div>`).join('')}</div>`:''}`;window.scrollTo({top:document.getElementById('billDetailsPanel').offsetTop-80,behavior:'smooth'})}
function calendarEventsForMonth(key){
  ensureBillOccurrences();generatePaycheckOccurrences();
  const events=[];
  db.billOccurrences.filter(o=>!o.superseded&&o.dueDate.startsWith(key)&&(getBill(o.billId)?.active!==false||occurrenceDisplayStatus(o)==='paid')).forEach(o=>{let b=getBill(o.billId);events.push({date:o.dueDate,type:'bill',label:b?.name||'Bill',amount:o.expectedAmount,status:occurrenceDisplayStatus(o),id:o.id})});
  db.paycheckOccurrences.filter(o=>String(o.scheduledDate||'').startsWith(key)&&paycheckOccurrenceVisibleInCalendar(o)&&paycheckOccurrenceStatus(o)!=='Cancelled').forEach(o=>{let p=getPaycheckSchedule(o.paycheckId),tx=occurrenceTransaction(o),date=tx?.date||o.scheduledDate,amount=tx?tx.amount:o.expectedAmount;events.push({date,type:'income',label:p?.name||'Paycheck',amount,status:paycheckOccurrenceStatus(o),id:o.id,txId:tx?.id||null})});
  db.transactions.filter(t=>['expense','savings','investment'].includes(t.type)&&String(t.date||'').startsWith(key)).forEach(t=>events.push({date:t.date,type:t.type,label:transactionDescription(t),amount:t.amount,status:'actual',id:t.id}));
  // Ordinary income transactions belong on the financial calendar even when they are not linked to a paycheck occurrence. Linked paycheck deposits are already represented by their occurrence above.
  db.transactions.filter(t=>t.type==='income'&&!t.paycheckOccurrenceId&&String(t.date||'').startsWith(key)).forEach(t=>events.push({date:t.date,type:'income',label:transactionDescription(t),amount:t.amount,status:'actual',id:t.id,txId:t.id}));
  return events;
}
function calendarFilterValue(){return $('calendarFilter')?.value||'all'}
function showFinancialDay(dateKey){let f=calendarFilterValue(),items=calendarEventsForMonth(billMonthKey()).filter(x=>x.date===dateKey&&(f==='all'||x.type===f));if(!items.length)return;$('modalTitle').textContent=`Financial activity for ${dateText(dateKey)}`;$('modalForm').innerHTML=`<div>${items.map(x=>{let action=x.type==='bill'?`closeModal();showBillOccurrence('${x.id}')`:x.type==='income'?(x.txId?`closeModal();showTransaction('${x.txId}')`:`closeModal();showPaycheckOccurrence('${x.id}')`):`closeModal();showTransaction('${x.id}')`;return `<div class="listrow"><button type="button" class="billDashLink" onclick="${action}"><span><b>${esc(x.label)}</b><br><span class="mini">${x.type==='income'?'Income':x.type==='bill'?'Bill':x.type==='savings'?'Savings':x.type==='investment'?'Investment':'Expense'} · ${x.status}</span></span></button><b>${money(x.amount)}</b></div>`}).join('')}</div>`;$('modalForm').dataset.type='dayDetail';$('modalBack').classList.add('show')}
function renderBills(){
 ensureBillOccurrences();generatePaycheckOccurrences();let key=billMonthKey(),[y,m]=key.split('-').map(Number),first=new Date(y,m-1,1),days=new Date(y,m,0).getDate(),start=first.getDay();$('calendarTitle').textContent=first.toLocaleDateString(undefined,{month:'long',year:'numeric'});
 let filter=calendarFilterValue(),events=calendarEventsForMonth(key).filter(e=>filter==='all'||e.type===filter);let monthBills=events.filter(e=>e.type==='bill');let allOverdue=db.billOccurrences.filter(o=>!o.superseded&&o.dueDate<localDateKey(today)&&['overdue','partial'].includes(occurrenceDisplayStatus(o))&&getBill(o.billId)?.active!==false&&occurrenceRemainingAmount(o)>0.005);let next7=db.billOccurrences.filter(o=>o.dueDate>=localDateKey(today)&&o.dueDate<=addDaysISO(localDateKey(today),7)&&billOccurrenceCountsAsObligation(o));let paidThisMonth=db.billOccurrences.flatMap(occurrencePayments).filter(t=>t.date.startsWith(currentMonth())).reduce((s,t)=>s+(+t.amount||0),0);
 $('billSummaryCards').innerHTML=[['Upcoming',upcomingBillOccurrences().reduce((s,o)=>s+occurrenceRemainingAmount(o),0),'unpaid future obligations'],['Due Soon',next7.reduce((s,o)=>s+occurrenceRemainingAmount(o),0),'next 7 days'],['Overdue',allOverdue.reduce((s,o)=>s+occurrenceRemainingAmount(o),0),'past-due obligations'],['Paid This Month',paidThisMonth,'actual bill payments']].map(x=>`<div class="card"><div class="label">${x[0]}</div><div class="metric">${money(x[1])}</div><div class="billSummaryNote">${x[2]}</div></div>`).join('');
 let cells=[];for(let i=0;i<start;i++)cells.push('<div class="day"></div>');for(let d=1;d<=days;d++){let ds=dateISO(y,m,d),es=events.filter(e=>e.date===ds);cells.push(`<div class="day ${ds===localDateKey(today)?'today':''}"><button type="button" class="dayHeaderBtn" onclick="showFinancialDay('${ds}')"><span class="daynum">${d}</span>${es.length?`<span class="dayCount">${es.length}</span>`:''}</button>${es.map(e=>`<button type="button" class="billEvent ${e.type} ${e.type==='income'?'paid':e.type==='expense'?'expense':e.type==='savings'||e.type==='investment'?'upcoming':e.status}" onclick="event.stopPropagation();${e.type==='bill'?`showBillOccurrence('${e.id}')`:e.type==='income'?(e.txId?`showTransaction('${e.txId}')`:`showPaycheckOccurrence('${e.id}')`):`showTransaction('${e.id}')`}"><span class="dot"></span><span>${esc(e.label)} · ${money(e.amount)}</span></button>`).join('')}</div>`)}
 $('calendar').innerHTML=`<div class="calendarHead">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(x=>`<div>${x}</div>`).join('')}</div><div class="calendarGrid">${cells.join('')}</div>`;
 $('overdueBillsSection').innerHTML=allOverdue.length?`<div class="sectionhead"><h2>Overdue Bills</h2><span class="mini">${allOverdue.length} occurrence${allOverdue.length===1?'':'s'}</span></div>${allOverdue.map(o=>{let b=getBill(o.billId),st=occurrenceDisplayStatus(o);return `<div class="listrow"><span><b>${esc(b?.name||'Bill')}</b><br><span class="mini">Due ${dateText(o.dueDate)} · Remaining ${money(occurrenceRemainingAmount(o))} · Expected ${money(o.expectedAmount)}</span></span><div class="billRowActions">${billStatusHtml(st)}<button class="btn small primary" onclick="openPaymentModal('${o.id}')">${st==='partial'?'Add Payment':'Mark Paid'}</button></div></div>`}).join('')}`:'';
 $('upcomingBills').innerHTML=upcomingBillOccurrences().map(o=>{let b=getBill(o.billId),st=occurrenceDisplayStatus(o);return `<div class="listrow"><span><b>${esc(b?.name||'Bill')}</b><br><span class="mini">${dateText(o.dueDate)} · Remaining ${money(occurrenceRemainingAmount(o))} · Expected ${money(o.expectedAmount)}</span></span><div class="billRowActions">${billStatusHtml(st)}<button class="btn small primary" onclick="openPaymentModal('${o.id}')">${st==='partial'?'Add Payment':'Mark Paid'}</button></div></div>`}).join('')||'<div class="empty">No unpaid upcoming bills.</div>';
 $('billMonthList').innerHTML=events.slice().sort((a,b)=>a.date.localeCompare(b.date)).map(e=>{const day=Number(e.date.slice(8,10)),typeLabel=e.type==='income'?'Income':e.type==='bill'?'Bill':e.type==='expense'?'Expense':e.type==='savings'?'Savings':'Investment';const action=e.type==='bill'?`showBillOccurrence('${e.id}')`:e.type==='income'?(e.txId?`showTransaction('${e.txId}')`:`showPaycheckOccurrence('${e.id}')`):`showTransaction('${e.id}')`;return `<div class="listrow"><div class="billMonthDay">${day}<br><span class="mini">${new Date(y,m-1,day).toLocaleDateString(undefined,{weekday:'short'})}</span></div><div class="billMonthItems"><div class="billMonthItem"><button onclick="${action}"><b>${esc(e.label)}</b><br><span class="mini">${typeLabel} · ${e.status}</span></button><b>${money(e.amount)}</b></div></div></div>`}).join('')||'<div class="empty">No events this month.</div>';
 const listMode=window.billMonthListView==='list';$('calendar').hidden=listMode;$('billMonthList').hidden=!listMode;$('billCalendarViewBtn')?.classList.toggle('active',!listMode);$('billListViewBtn')?.classList.toggle('active',listMode);
 $('billCalendarViewBtn').onclick=()=>{window.billMonthListView='calendar';$('calendar').hidden=false;$('billMonthList').hidden=true;$('billCalendarViewBtn').classList.add('active');$('billListViewBtn').classList.remove('active')};$('billListViewBtn').onclick=()=>{window.billMonthListView='list';$('calendar').hidden=true;$('billMonthList').hidden=false;$('billListViewBtn').classList.add('active');$('billCalendarViewBtn').classList.remove('active')};
 $('activeBills').innerHTML=db.bills.filter(b=>b.active!==false).sort((a,b)=>String(a.name).localeCompare(String(b.name))).map(b=>{let next=db.billOccurrences.filter(o=>o.billId===b.id&&!o.superseded&&occurrenceDisplayStatus(o)!=='paid'&&o.dueDate>=localDateKey(today)).sort((a,c)=>a.dueDate.localeCompare(c.dueDate))[0];return `<div class="listrow"><span><b>${esc(b.name)}</b><br><span class="mini">${esc(b.category)} · ${esc(b.frequency)} · ${money(b.expectedAmount)}</span></span><div class="billRowActions"><button class="btn small" onclick="openBillEdit('${b.id}')">Edit</button>${next?`<button class="btn small" onclick="showBillOccurrence('${next.id}')">Details</button>`:''}<button class="btn small danger" onclick="deactivateBill('${b.id}')">Deactivate</button></div></div>`}).join('')||'<div class="empty">No active bills.</div>';
}

function openBillEdit(id){let b=getBill(id);if(!b)return;openModal('billEdit',b)}
function retireFutureBillOccurrences(billId,cutoff){const removeIds=new Set(),retiredIds=new Set();(db.billOccurrences||[]).forEach(o=>{if(String(o.billId)!==String(billId)||String(o.dueDate||'')<=cutoff)return;retiredIds.add(o.id);if(occurrencePaidAmount(o)>0){o.superseded=true;}else removeIds.add(o.id);});if(removeIds.size)db.billOccurrences=db.billOccurrences.filter(o=>!removeIds.has(o.id));if(retiredIds.size){const assignmentIds=new Set((db.assignments||[]).filter(a=>a.type==='bill'&&retiredIds.has(a.targetId)).map(a=>a.id));db.assignments=(db.assignments||[]).filter(a=>!assignmentIds.has(a.id));(db.paycheckOccurrences||[]).forEach(o=>{if(Array.isArray(o.allocationIds))o.allocationIds=o.allocationIds.filter(id=>!assignmentIds.has(id));});}}
function reconcileEditedBill(old,bill,todayKey=localDateKey(today)){const wasActive=old.active!==false,scheduleChanged=old.startDate!==bill.startDate||old.frequency!==bill.frequency||old.billType!==bill.billType,reactivated=!wasActive&&bill.active,deactivated=wasActive&&!bill.active;Object.assign(old,bill);old.occurrenceGenerationStartDate=todayKey;if(deactivated)old.deactivatedAt=todayKey;else if(reactivated)delete old.deactivatedAt;if(scheduleChanged||reactivated||deactivated){retireFutureBillOccurrences(old.id,todayKey);}else if(old.active!==false){db.billOccurrences.filter(x=>x.billId===old.id&&String(x.dueDate||'')>todayKey&&occurrencePaidAmount(x)===0&&!x.superseded).forEach(x=>{x.expectedAmount=bill.expectedAmount;x.debtId=bill.debtId&&debtPaymentDateValid(bill.debtId,x.dueDate)?bill.debtId:null;x.status=occurrenceStatus(x)});}return {scheduleChanged,reactivated,deactivated};}
function deactivateBill(id){let b=getBill(id);if(!b)return;if(confirm(`Deactivate ${b.name}? Future occurrences will stop, but payment history will remain.`)){b.active=false;b.deactivatedAt=localDateKey(today);retireFutureBillOccurrences(id,b.deactivatedAt);save();ensureBillOccurrences();render()}}
function openPaymentModal(occId){ensureBillOccurrences();let o=getOccurrence(occId),b=o&&getBill(o.billId);if(!o||!b)return;let paid=occurrencePaidAmount(o),remaining=Math.max(0,(+o.expectedAmount||0)-paid),todayKey=localDateKey(today);if(occurrenceDisplayStatus(o)==='paid'){showBillOccurrence(occId);return}$('modalTitle').textContent=paid?'Add payment':'Mark bill paid';$('modalForm').innerHTML=`<div class="formgrid">${f('Bill','billName','text',b.name,'readonly')}${f('Payment date','date','date',todayKey,'required')}${f('Actual amount','amount','number',remaining||o.expectedAmount,'required min="0.01" step=".01"')}${f('Payment account','account','text','','placeholder="Checking"')}${s('Category','category',db.categories,b.category||'Other')}${f('Payment note','note')}<div class="full"><div class="notice">Due ${dateText(o.dueDate)} · Expected ${money(o.expectedAmount)} · Already paid ${money(paid)}. This creates one Transaction linked to this bill occurrence.</div></div><div class="full"><button class="btn primary" type="submit">Save payment</button></div></div>`;$('modalForm').dataset.type='payment';$('modalForm').dataset.occurrenceId=occId;$('modalBack').classList.add('show')}

let budgetViewMonth=currentMonth();
function shiftBudgetMonth(delta){let [y,m]=budgetViewMonth.split('-').map(Number);let d=new Date(y,m-1+delta,1);budgetViewMonth=monthKeyFromDate(d);renderBudgets();}
function budgetActual(category,month){return db.transactions.filter(t=>isOutflowTransaction(t)&&t.category===category&&String(t.date||'').startsWith(month)).reduce((s,t)=>s+(+t.amount||0),0)}
function renderBudgets(){
  const m=budgetViewMonth||currentMonth();
  const records=budgetApplicableRecords(m).sort((a,b)=>String(a.category).localeCompare(String(b.category)));
  const totals=records.reduce((acc,b)=>{let spent=budgetActual(b.category,m);acc.budgeted+=+b.amount||0;acc.spent+=spent;return acc},{budgeted:0,spent:0});
  totals.remaining=totals.budgeted-totals.spent;
  totals.used=totals.budgeted>0?(totals.spent/totals.budgeted*100):0;
  const canEditMonth=m>=currentMonth();
  $('budgetMonthLabel').textContent=budgetMonthLabel(m);
  $('budgetMonthStatus').textContent=m===currentMonth()?'Current month':(m<currentMonth()?'Historical':'Planned');
  $('budgetPrev').disabled=false;$('budgetNext').disabled=false;
  $('budgetSummary').innerHTML=[['Total Budgeted',money(totals.budgeted),''],['Total Spent',money(totals.spent),totals.spent>totals.budgeted?'bad':''],['Remaining',money(totals.remaining),totals.remaining>=0?'good':'bad'],['Used',totals.budgeted?totals.used.toFixed(1)+'%':'—',totals.used<=100?'':'bad']].map(a=>`<div class="card budgetSummaryCard"><div class="label">${a[0]}</div><div class="metric ${a[2]}">${a[1]}</div></div>`).join('');
  $('budgetList').innerHTML=records.map(b=>{
    const spent=budgetActual(b.category,m),amount=+b.amount||0,remaining=amount-spent,used=amount?spent/amount*100:0,bar=Math.min(100,Math.max(0,used)),over=remaining<0,changeDate=String(b.effectiveMonth)===m?b.effectiveMonth:null;
    return `<div class="card budgetCard ${over?'budgetOver':''}"><div class="sectionhead"><div><b>${esc(b.category)}</b><div class="mini">${String(b.effectiveMonth)===m?'Budget set for this month':`Budget active since ${budgetMonthLabel(b.effectiveMonth)}`}</div></div><div class="billRowActions">${canEditMonth?`<button class="btn small" onclick="openBudgetEdit('${b.id}')">Edit</button>`:''}${canEditMonth&&String(b.effectiveMonth)>=currentMonth()?`<button class="btn small danger" onclick="deleteBudgetChange('${b.id}')">Delete</button>`:''}</div></div><div class="budgetNumbers"><div><span class="label">Budgeted</span><b>${money(amount)}</b></div><div><span class="label">Spent</span><b>${money(spent)}</b></div><div><span class="label">${over?'Over budget':'Remaining'}</span><b class="${over?'bad':remaining>=0?'good':''}">${money(Math.abs(remaining))}</b></div></div><div class="progress section"><div class="bar ${over?'budgetBarOver':''}" style="width:${bar}%"></div></div><div class="sectionhead budgetFoot"><span class="mini">${used.toFixed(0)}% used</span><span class="mini">${over?`${money(Math.abs(remaining))} over budget`:changeDate?`Effective ${budgetMonthLabel(changeDate)}`:'Recurring monthly plan'}</span></div></div>`;
  }).join('')||`<div class="empty budgetEmpty"><b>No budgets for ${budgetMonthLabel(m)}.</b><br><span class="mini">Add a monthly budget to start planning your spending.</span></div>`;
  $('budgetHistoryNotice').textContent=m<currentMonth()?'Historical view — this shows the budget that was in effect during this month. Changes made now will not rewrite this month.':m===currentMonth()?'Budgets continue automatically each month until you change them.':'Planned future month — budgets shown here reflect the latest changes effective by this month.';
}
function openBudgetEdit(id){const b=db.budgets.find(x=>x.id===id);if(!b)return alert('That budget change no longer exists.');if(budgetViewMonth<currentMonth())return alert('Historical budgets are view-only.');if(String(b.effectiveMonth)<currentMonth())openModal('budgetEdit',{...b,id:'',effectiveMonth:currentMonth()});else openModal('budgetEdit',b)}
function deleteBudgetChange(id){const b=db.budgets.find(x=>x.id===id);if(!b)return;if(String(b.effectiveMonth)<currentMonth())return alert('This budget is part of historical budget history and cannot be deleted from the current plan. Edit it to create a new current/future budget instead.');if(!confirm(`Delete the ${b.category} budget change effective ${budgetMonthLabel(b.effectiveMonth)}?\n\nEarlier budget history and all transactions will remain unchanged.`))return;db.budgets=db.budgets.filter(x=>x.id!==id);save();renderBudgets();}
function resetBudgetToCurrent(){budgetViewMonth=currentMonth();renderBudgets()}
window.shiftBudgetMonth=shiftBudgetMonth;window.openBudgetEdit=openBudgetEdit;window.deleteBudgetChange=deleteBudgetChange;window.resetBudgetToCurrent=resetBudgetToCurrent;
function scheduledBillAmountForRange(b,start,end,throughDate=null){
 if(!b?.id)return 0;
 ensureBillOccurrences();
 return (db.billOccurrences||[]).filter(o=>o.billId===b.id&&String(o.dueDate||'')>=start&&String(o.dueDate||'')<=end&&(!throughDate||String(o.dueDate||'')<=throughDate)&&billOccurrenceIncludedInPlannedHistory(o)).reduce((sum,o)=>sum+(+o.expectedAmount||0),0);
}
function annualBillAmount(b,y,throughDate=null){const year=String(y);return scheduledBillAmountForRange(b,`${year}-01-01`,`${year}-12-31`,throughDate)}
function plannedBillTotalForMonth(key,throughDate=null,activeOnly=false){const [y,m]=key.split('-').map(Number),start=`${key}-01`,end=dateISO(y,m,new Date(y,m,0).getDate());ensureBillOccurrences();return (db.billOccurrences||[]).filter(o=>{const bill=getBill(o.billId);return String(o.dueDate||'')>=start&&String(o.dueDate||'')<=end&&(!throughDate||String(o.dueDate||'')<=throughDate)&&billOccurrenceIncludedInPlannedHistory(o)&&(!activeOnly||bill?.active!==false)}).reduce((sum,o)=>sum+(+o.expectedAmount||0),0)}

function annualYears(){const current=today.getFullYear();return [String(current),String(current-1),String(current-2)];}

function annualPeriodTransactions(y,monthStart,monthEnd,throughDate=null){
 const start=`${y}-${String(monthStart).padStart(2,'0')}-01`;
 const endMonth=String(monthEnd).padStart(2,'0');
 const endDate=new Date(+y,monthEnd,0).getDate();
 const end=`${y}-${endMonth}-${String(endDate).padStart(2,'0')}`;
 return (db.transactions||[]).filter(t=>/^\d{4}-\d{2}-\d{2}$/.test(String(t.date||''))&&t.date>=start&&t.date<=end&&(!throughDate||t.date<=throughDate));
}
function annualCategoryBreakdown(entries){
 const totals={};
 entries.forEach(t=>{const category=String(t.category||'Other');totals[category]=(totals[category]||0)+(Number(t.amount)||0);});
 const sorted=Object.entries(totals).sort((a,b)=>b[1]-a[1]);
 if(sorted.length<=7)return sorted.map(([l,v])=>({l,v}));
 const top=sorted.slice(0,6),rest=sorted.slice(6),other=rest.filter(([k])=>k==='Other').reduce((a,x)=>a+x[1],0),remaining=rest.filter(([k])=>k!=='Other').reduce((a,x)=>a+x[1],0);
 return [...top.map(([l,v])=>({l,v})),...(remaining?[{l:'Other categories',v:remaining}]:[]),...(other&&top.every(([k])=>k!=='Other')?[{l:'Other',v:other}]:[])];
}
function annualData(y,throughDate=null){
 const year=String(y),tx=(db.transactions||[]).filter(t=>/^\d{4}-\d{2}-\d{2}$/.test(String(t.date||''))&&String(t.date||'').startsWith(year+'-')&&(!throughDate||String(t.date||'')<=throughDate));
 const isIncome=t=>t?.type==='income',isSpend=t=>isOutflowTransaction(t),sum=rows=>rows.reduce((total,t)=>total+(Number(t.amount)||0),0);
 const incomeTx=tx.filter(isIncome),spendingTx=tx.filter(isSpend),expenseTx=tx.filter(t=>t.type==='expense'),billTx=tx.filter(t=>t.type==='bill'),savingsTx=tx.filter(t=>t.type==='savings'),investmentTx=tx.filter(t=>t.type==='investment');
 const earned=sum(incomeTx),spent=sum(spendingTx),expenses=sum(expenseTx),billsPaid=sum(billTx),savingsContributions=sum(savingsTx.filter(t=>(+t.amount||0)>0)),savingsWithdrawals=Math.abs(sum(savingsTx.filter(t=>(+t.amount||0)<0))),netSavingsActivity=sum(savingsTx),investmentContributions=sum(investmentTx.filter(t=>(+t.amount||0)>0)),net=earned-spent;
 const expenseCats={},incomeCats={};spendingTx.forEach(t=>{const k=t.category||'Other';expenseCats[k]=(expenseCats[k]||0)+(Number(t.amount)||0)});incomeTx.forEach(t=>{const k=t.description||t.category||'Other';incomeCats[k]=(incomeCats[k]||0)+(Number(t.amount)||0)});
 const quarters=[1,2,3,4].map(q=>{const from=q*3-2,to=q*3,rows=annualPeriodTransactions(year,from,to,throughDate),inc=sum(rows.filter(isIncome)),expenses=sum(rows.filter(t=>t.type==='expense')),billsPaid=sum(rows.filter(t=>t.type==='bill')),sp=expenses+billsPaid,sav=sum(rows.filter(t=>t.type==='savings'&&(+t.amount||0)>0)),inv=sum(rows.filter(t=>t.type==='investment'&&(+t.amount||0)>0)),debt=sum(rows.filter(t=>isSpend(t)&&t.debtId));return {q:`Q${q}`,earned:inc,expenses,billsPaid,spent:sp,net:inc-sp,saved:inc-sp,rate:inc?(sav/inc*100):0,debt,savings:sav,investments:inv,recordCount:rows.length};});
 const months=Array.from({length:12},(_,i)=>{const m=i+1,prefix=`${year}-${String(m).padStart(2,'0')}`,rows=tx.filter(t=>String(t.date||'').startsWith(prefix)),inc=sum(rows.filter(isIncome)),expenses=sum(rows.filter(t=>t.type==='expense')),billsPaid=sum(rows.filter(t=>t.type==='bill')),sp=expenses+billsPaid,debt=sum(rows.filter(t=>isSpend(t)&&t.debtId)),savings=sum(rows.filter(t=>t.type==='savings'&&(+t.amount||0)>0)),investments=sum(rows.filter(t=>t.type==='investment'&&(+t.amount||0)>0)),bills=plannedBillTotalForMonth(prefix,throughDate,!!throughDate);return {m,label:new Date(+year,i,1).toLocaleDateString(undefined,{month:'short'}),earned:inc,expenses,billsPaid,spent:sp,net:inc-sp,bills,debt,savings,investments,recordCount:rows.length,hasElapsed:!throughDate||`${prefix}-01`<=throughDate};});
 const bills=(db.bills||[]).filter(b=>!throughDate||b.active!==false).map(b=>({name:b.name||'Unnamed bill',amount:annualBillAmount(b,year),category:b.category||'Other'})).filter(x=>x.amount>0).sort((a,b)=>b.amount-a.amount),plannedBills=bills.reduce((a,x)=>a+x.amount,0);
 const goalSnapshots=db.goals.filter(g=>String(g.createdAt||'').slice(0,10)<=(throughDate||`${year}-12-31`)),goalBalances=goalSnapshots.reduce((a,g)=>a+goalBalanceAt(g.id,throughDate||`${year}-12-31`),0);
 return {tx,earned,spent,expenses,billsPaid,net,expenseCats,incomeCats,months,quarters,bills,totalBills:plannedBills,plannedBills,savingsContributions,savingsWithdrawals,netSavingsActivity,investmentContributions,savingsRate:earned?net/earned*100:null,goalBalances,availableCash:currentEstimatedCash(),hasTransactions:tx.length>0,hasIncome:incomeTx.length>0,hasExpenseData:spendingTx.length>0};
}
function renderAnnual(){
 const years=annualYears(),sel=$('annualYear'),current=String(today.getFullYear());
 if(sel){const old=sel.value;sel.innerHTML=years.map(y=>`<option value="${y}">${y}${y===current?' (YTD)':''}</option>`).join('');sel.value=years.includes(old)?old:current;}
 const y=sel?.value||current,isCurrentYear=y===current,currentCutoff=isCurrentYear?localDateKey(today):null,d=annualData(y,currentCutoff),comparisonYear=String(Number(y)-1),prev=annualData(comparisonYear,null);
 const pct=(v)=>d.earned>0?`${(v/d.earned*100).toFixed(1)}% of income`:'Income percentage unavailable';
 const metricChange=(now,before,hasBefore)=>!hasBefore?'No prior data':before===0?(now===0?'No change':'No prior data'):`${((now-before)/Math.abs(before)*100)>0?'+':''}${((now-before)/Math.abs(before)*100).toFixed(1)}% vs ${comparisonYear}`;
 const card=(label,value,change='',tone='')=>`<div class="card annualMetricCard"><div class="label">${label}</div><div class="metric ${tone}">${value}</div>${change?`<div class="annualMetricChange">${change}</div>`:''}</div>`;
 $('annualCards').innerHTML=[
  card('Income',d.hasIncome?money(d.earned):'No recorded data',metricChange(d.earned,prev.earned,prev.hasIncome),'good'),
  card('Expenses & bills paid',d.hasExpenseData?money(d.spent):'No recorded data',`${pct(d.spent)} · ${metricChange(d.spent,prev.spent,prev.hasExpenseData)}`,'bad'),
  card('Net cash flow',d.hasTransactions?money(d.net):'Insufficient data',metricChange(d.net,prev.net,prev.hasTransactions),d.net>=0?'good':'bad'),
  card('Savings contributions',money(d.savingsContributions),`${pct(d.savingsContributions)} · Withdrawals ${money(d.savingsWithdrawals)}`),
  card('Investment contributions',money(d.investmentContributions),pct(d.investmentContributions)),
  card(`Planned bills (${y})`,money(d.totalBills),`${pct(d.totalBills)} · ${d.bills.length} scheduled bill${d.bills.length===1?'':'s'}`),
  card('Net cash-flow rate',d.earned?`${d.savingsRate.toFixed(1)}%`:'—','(Income − expenses and bills) ÷ income; savings transfers shown separately'),
  card('Available cash today',d.availableCash==null?'Set starting cash date':money(d.availableCash),'Current snapshot · not historical')
 ].join('');
 $('annualIncomeNote').textContent=`${Object.keys(d.incomeCats).length} income sources · hover for amounts and shares`; 
 $('annualExpenseNote').textContent=`${Object.keys(d.expenseCats).length} categories · expenses and bill payments separated below`;
 const incomeBreakdown=annualCategoryBreakdown(Object.entries(d.incomeCats).map(([category,amount])=>({category,amount}))),expenseBreakdown=annualCategoryBreakdown(Object.entries(d.expenseCats).map(([category,amount])=>({category,amount})));
 canvas('annualIncomeChart','pie',incomeBreakdown);canvas('annualExpenseChart','pie',expenseBreakdown);
 annualLegend('annualIncomeLegend',incomeBreakdown);annualLegend('annualExpenseLegend',expenseBreakdown);
 if($('annualPlannedBillsTitle'))$('annualPlannedBillsTitle').textContent=`Planned bills (${y})`;if($('annualActualBillsTitle'))$('annualActualBillsTitle').textContent=isCurrentYear?'Actual bills paid (YTD)':'Actual bills paid';canvas('annualBillsChart','hbars',d.bills.slice(0,10).map(x=>({l:x.name,name:x.name,amount:x.amount})));annualLegend('annualBillsLegend',[{l:'Planned bills',color:FINANCE_CHART_COLORS.bills}]);const actualBillsById=new Map();d.tx.filter(t=>t.type==='bill'&&t.billOccurrenceId).forEach(t=>{const occ=getOccurrence(t.billOccurrenceId),bill=occ&&getBill(occ.billId);if(!bill)return;const key=String(bill.id);if(!actualBillsById.has(key))actualBillsById.set(key,{l:bill.name||'Unnamed bill',name:bill.name||'Unnamed bill',amount:0});actualBillsById.get(key).amount+=Number(t.amount)||0;});const actualBills=[...actualBillsById.values()].filter(x=>x.amount>0).sort((a,b)=>b.amount-a.amount);canvas('annualActualBillsChart','hbars',actualBills.slice(0,10));annualLegend('annualActualBillsLegend',[{l:'Actual bills paid',color:FINANCE_CHART_COLORS.bills}]);
 canvas('annualQuarterChart','grouped',d.quarters.map(x=>({l:x.q,earned:x.earned,expenses:x.expenses,billsPaid:x.billsPaid,net:x.net,recordCount:x.recordCount})));annualLegend('annualQuarterLegend',[{l:'Income',color:FINANCE_CHART_COLORS.income},{l:'Expenses',color:FINANCE_CHART_COLORS.expense},{l:'Bills paid',color:FINANCE_CHART_COLORS.bills},{l:'Net cash flow',color:FINANCE_CHART_COLORS.debt}]);
 const visibleMonths=d.months;
 canvas('annualMonthlyChart','grouped',visibleMonths.map(x=>({l:x.label,earned:x.earned,expenses:x.expenses,billsPaid:x.billsPaid,net:x.net,recordCount:x.recordCount})));annualLegend('annualMonthlyLegend',[{l:'Income',color:FINANCE_CHART_COLORS.income},{l:'Expenses',color:FINANCE_CHART_COLORS.expense},{l:'Bills paid',color:FINANCE_CHART_COLORS.bills},{l:'Net cash flow',color:FINANCE_CHART_COLORS.debt}]);
 $('annualQuarterTable').innerHTML=d.quarters.map((x,i)=>{const p=i===0?prev.quarters[3]:d.quarters[i-1],hasPrior=i===0?prev.hasTransactions:p.recordCount>0;const change=!hasPrior?'No prior data':p.earned===0?(x.earned===0?'No change':'No prior data'):`${((x.earned-p.earned)/Math.abs(p.earned)*100)>0?'+':''}${((x.earned-p.earned)/Math.abs(p.earned)*100).toFixed(1)}% vs previous quarter`;return `<tr><td><b>${x.q}</b><div class="mini">${x.recordCount?`Income: ${change}`:'No transactions recorded'}</div></td><td class="good">${x.recordCount?money(x.earned):'—'}</td><td class="bad">${x.recordCount?money(x.spent):'—'}</td><td class="${x.saved>=0?'good':'bad'}">${x.recordCount?money(x.saved):'—'}</td><td>${x.recordCount&&x.earned?`${x.rate.toFixed(1)}%`:'—'}</td><td>${x.recordCount?money(x.debt):'—'}</td></tr>`;}).join('');
 $('annualMonthTable').innerHTML=d.months.map((x,i,arr)=>{const p=i===0?prev.months[11]:arr[i-1],hasPrior=i===0?prev.hasTransactions:arr[i-1].recordCount>0,change=!hasPrior?'No prior data':p.earned===0?(x.earned===0?'No change':'No prior data'):`${((x.earned-p.earned)/Math.abs(p.earned)*100)>0?'+':''}${((x.earned-p.earned)/Math.abs(p.earned)*100).toFixed(1)}% vs previous month`;return `<tr><td><b>${x.label}</b><div class="mini">${x.recordCount?`Income: ${change}`:'No transactions recorded'}</div></td><td class="good">${x.recordCount?money(x.earned):'—'}</td><td class="bad">${x.recordCount?money(x.spent):'—'}</td><td class="${x.net>=0?'good':'bad'}">${x.recordCount?money(x.net):'—'}</td><td>${x.hasElapsed?money(x.bills):'—'}</td><td>${x.recordCount?money(x.debt):'—'}</td></tr>`;}).join('');
 $('annualDebtList').innerHTML=db.debts.slice().sort((a,b)=>debtCurrentBalance(b)-debtCurrentBalance(a)).map(x=>{let p=payoff(x);return `<div class="listrow"><span><b>${esc(x.name)}</b><br><span class="mini">${(+x.apr).toFixed(2)}% APR · ${p.date}</span></span><b>${money(debtCurrentBalance(x))}</b></div>`;}).join('')||'<div class="empty">No debt accounts added.</div>';
 const debtHeading=$('annualDebtList')?.closest('.card')?.querySelector('h2');if(debtHeading)debtHeading.textContent='Current debt overview';
 const debtHead=$('annualDebtList')?.closest('.card')?.querySelector('.sectionhead');if(debtHead&&!debtHead.querySelector('.mini')){const note=document.createElement('span');note.className='mini';note.textContent='Current balances, not year-end history';debtHead.appendChild(note);}
 renderAnnualExpenseDetails(d);renderFinancialHealth(y,d,isCurrentYear);
}
function annualLegend(id,items){const el=$(id);if(!el)return;const colors=PIE_CHART_COLORS,total=items.reduce((s,x)=>s+(Number(x.v)||0),0);el.innerHTML=items.map((item,i)=>{const value=Number(item.v),detail=Number.isFinite(value)?` · ${money(value)}${total?` (${(value/total*100).toFixed(1)}%)`:''}`:'';return `<span class="annualLegendItem"><i style="background:${item.color||colors[i%colors.length]}"></i>${esc(item.l||'')}${detail}</span>`;}).join('');}
function renderAnnualExpenseDetails(d){const root=$('annualExpenseDetails');if(!root)return;const exp=d.tx.filter(t=>t.type==='expense'),bills=d.tx.filter(t=>t.type==='bill'),groups=[{name:'Expenses',rows:exp},{name:'Bills',rows:bills}];root.innerHTML=groups.map(g=>{const total=g.rows.reduce((a,t)=>a+(+t.amount||0),0);const rows=g.rows.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))).map(t=>`<div class="annualExpenseRow"><span>${esc(t.description||t.category||'Transaction')}<small>${dateText(t.date)} · ${esc(t.category||'Other')}</small></span><b>${money(t.amount)}</b></div>`).join('');return `<details class="annualExpenseGroup"><summary><span>${g.name} <small>(${g.rows.length})</small></span><b>${money(total)}</b></summary><div class="annualExpenseRows">${rows||'<div class="mini">No recorded transactions for this section.</div>'}</div></details>`}).join('');}
function billPaidAmountAsOf(occurrence, cutoff){
 const payments=occurrencePayments(occurrence).filter(t=>String(t.date||'')<=cutoff);
 let amount=payments.reduce((sum,t)=>sum+(Number(t.amount)||0),0);
 if(!payments.length&&String(occurrence.paidDate||'')<=cutoff&&occurrence.paidDate){
  amount=Number.isFinite(+occurrence.actualAmount)&&+occurrence.actualAmount>0?+occurrence.actualAmount:(['paid','deposited'].includes(String(occurrence.status||'').toLowerCase())?(+occurrence.expectedAmount||0):0);
 }
 return Math.max(0,amount);
}
function renderFinancialHealth(year,d,isCurrentYear){
 const root=$('annualFinancialHealth');if(!root)return;
 const todayKey=localDateKey(today),yearEnd=`${year}-12-31`,asOf=isCurrentYear?todayKey:yearEnd;
 const actualYearTx=d.tx, income=d.earned, net=d.net;
 const monthly=d.months.filter(m=>m.hasElapsed&&m.recordCount>0),recent=monthly.slice(-3),negativeRecent=recent.filter(m=>m.earned-m.spent<-.005).length;
 const health=[];const add=(name,status,detail,icon)=>health.push({name,status,detail,icon});
 let cashStatus='Insufficient data',cashDetail='Reliable income and spending records are needed to assess cash flow.';
 if(d.hasIncome||d.hasExpenseData){const deficit=net<0?Math.abs(net):0,deficitRate=income>0?deficit/income:null;if(net<-.005){cashStatus=(deficitRate!==null&&deficitRate>=.20)||deficit>=10000||negativeRecent>=2?'At risk':'Needs attention';cashDetail=`Your spending exceeded your income by ${money(deficit)}${deficitRate!==null?` (${(deficitRate*100).toFixed(1)}% of income)`:''} ${isCurrentYear?'this year to date':'in '+year}.`;}else if(negativeRecent>=2){cashStatus='Needs attention';cashDetail=`Your net cash flow was positive overall, but ${negativeRecent} of the latest ${recent.length} recorded months were negative.`;}else{cashStatus='Healthy';cashDetail=`Your net cash flow was ${money(net)} ${isCurrentYear?'this year to date':'in '+year}.`;}}
 add('Cash flow',cashStatus,cashDetail,'trending-up');
 ensureBillOccurrences();
 let overdue=[],upcoming=[],billStatus='Insufficient data',billDetail='Reliable bill occurrence history is not available for this period.';
 const currentMonthlyBills=(db.bills||[]).filter(b=>b.active!==false).reduce((sum,b)=>sum+scheduledBillAmountForRange(b,`${currentMonth()}-01`,dateISO(+currentMonth().slice(0,4),+currentMonth().slice(5),new Date(+currentMonth().slice(0,4),+currentMonth().slice(5),0).getDate())),0);
 if(isCurrentYear){
  const overdueCandidates=db.billOccurrences.filter(o=>{const b=getBill(o.billId);return !!b&&b.active!==false&&String(o.dueDate||'')<todayKey;});
  overdue=overdueCandidates.filter(o=>billPaidAmountAsOf(o,todayKey)<Math.max(0,+o.expectedAmount||0));
  upcoming=db.billOccurrences.filter(o=>{const b=getBill(o.billId);return !!b&&b.active!==false&&String(o.dueDate||'')>=todayKey&&String(o.dueDate||'')<=addDaysISO(todayKey,30)&&billPaidAmountAsOf(o,todayKey)<Math.max(0,+o.expectedAmount||0);});
  if(db.bills.some(b=>b.active!==false)||actualYearTx.some(t=>t.type==='bill')){
   billStatus=overdue.length?'Needs attention':'Healthy';if(overdue.length>=3)billStatus='At risk';
   billDetail=`You have ${overdue.length} overdue bill${overdue.length===1?'':'s'} and ${upcoming.length} upcoming obligation${upcoming.length===1?'':'s'} in the next 30 days. Current scheduled monthly bills total ${money(currentMonthlyBills)}.`;
  }
 }else{
  const yearOccurrences=db.billOccurrences.filter(o=>{const b=getBill(o.billId);return !!b&&b.active!==false&&String(o.dueDate||'').startsWith(`${year}-`);});
  const nextWindowEnd=addDaysISO(yearEnd,30),yearEndUpcoming=db.billOccurrences.filter(o=>{const b=getBill(o.billId);return !!b&&b.active!==false&&String(o.dueDate||'')>yearEnd&&String(o.dueDate||'')<=nextWindowEnd;});
  if(yearOccurrences.length){
   overdue=yearOccurrences.filter(o=>String(o.dueDate||'')<yearEnd&&billPaidAmountAsOf(o,yearEnd)<Math.max(0,+o.expectedAmount||0));
   upcoming=yearEndUpcoming.filter(o=>billPaidAmountAsOf(o,yearEnd)<Math.max(0,+o.expectedAmount||0));
   billStatus=overdue.length?'Needs attention':'Healthy';if(overdue.length>=3)billStatus='At risk';
   billDetail=`At the end of ${year}, ${overdue.length} bill${overdue.length===1?' was':'s were'} overdue and ${upcoming.length} upcoming obligation${upcoming.length===1?'':'s'} were recorded for the following 30 days. Current scheduled monthly bills total ${money(currentMonthlyBills)}.`;
  }else if(!db.bills.length&&!actualYearTx.some(t=>t.type==='bill')){
   billStatus='Insufficient data';billDetail=`No bill records are available to assess ${year}.`;
  }else{
   billStatus='Insufficient data';billDetail=`Historical bill occurrence records for ${year} are unavailable, so overdue bills cannot be reliably determined. Current scheduled monthly bills total ${money(currentMonthlyBills)}.`;
  }
 }
 add('Bills & obligations',billStatus,billDetail,'calendar-clock');
 const debtPayTx=actualYearTx.filter(t=>isOutflowTransaction(t)&&t.debtId),debtPayments=debtPayTx.reduce((a,t)=>a+(+t.amount||0),0),monthCount=isCurrentYear?Math.max(1,today.getMonth()+1):12,monthlyIncome=income/monthCount,annualizedIncome=isCurrentYear&&monthCount>0?income/monthCount*12:income,plannedDebtMinimum=db.debts.filter(x=>x.status!=='paid-off'&&x.status!=='archived').reduce((a,x)=>a+(+x.minimum||0),0),monthlyDebt=debtPayTx.length?debtPayments/monthCount:plannedDebtMinimum,burden=monthlyIncome>0?monthlyDebt/monthlyIncome:null,activeDebts=db.debts.filter(x=>x.status!=='paid-off'&&x.status!=='archived'),totalDebt=activeDebts.reduce((a,x)=>a+debtCurrentBalance(x),0),debtToIncome=annualizedIncome>0?totalDebt/annualizedIncome:null;
 let debtStatus='Insufficient data',debtDetail='Debt and income records are not sufficient to assess the burden.';
 if(activeDebts.length){if(burden===null){debtStatus='Insufficient data';debtDetail=`Your current debt balance is ${money(totalDebt)}, but income data is insufficient to compare it with your income.`;}else{const paymentStatus=burden>=.45?'At risk':burden>=.30?'Needs attention':'Healthy',balanceStatus=debtToIncome===null?'Insufficient data':debtToIncome>=5?'At risk':debtToIncome>=3?'Needs attention':'Healthy';const rank={Healthy:0,'Needs attention':1,'At risk':2,'Insufficient data':-1};debtStatus=rank[balanceStatus]>rank[paymentStatus]?balanceStatus:paymentStatus;if(debtStatus==='Insufficient data')debtStatus=paymentStatus;const paymentPct=income>0?debtPayments/income*100:null;debtDetail=`Your current debt balance is ${money(totalDebt)}; recorded debt payments account for ${paymentPct===null?'an unavailable share':paymentPct.toFixed(1)+'% of '+year+' income'}. Check that your payment records and debt accounts are complete.`;}}else if(debtPayTx.length){debtStatus='Needs attention';debtDetail='Recorded debt payments exist, but no active debt accounts are available to verify current balances.';}
 add('Debt burden',debtStatus,debtDetail,'landmark');
 const goalsBefore=db.goals.filter(g=>String(g.createdAt||'').slice(0,10)<=asOf),goalTx=actualYearTx.filter(t=>t.type==='savings'),netSavings=goalTx.reduce((a,t)=>a+(+t.amount||0),0),goalRate=income>0?netSavings/income:null;
 let savingsStatus='Insufficient data',savingsDetail='Savings and income records are not sufficient to assess your savings activity.';
 if(goalTx.length||goalsBefore.length){const activeGoals=goalsBefore.filter(g=>g.status!=='archived'),progress=activeGoals.filter(g=>(+g.target||0)>0&&goalBalanceAt(g.id,asOf)>0);if(goalRate===null){savingsStatus='Insufficient data';savingsDetail=`Your savings rate cannot be calculated because recorded income is unavailable.`;}else if(goalRate<0){savingsStatus='At risk';savingsDetail=`Your net savings activity was ${money(netSavings)} (${(goalRate*100).toFixed(1)}% of income). Withdrawals exceeded contributions.`;}else if(goalRate<.02){savingsStatus='Needs attention';savingsDetail=`Your net savings activity was ${money(netSavings)} (${(goalRate*100).toFixed(1)}% of income). Consider increasing your contributions toward your goals.`;}else if(goalRate<.05){savingsStatus='Needs attention';savingsDetail=`Your net savings activity was ${money(netSavings)} (${(goalRate*100).toFixed(1)}% of income). Consider increasing your contributions toward your goals.`;}else{savingsStatus='Healthy';savingsDetail=`Your net savings activity was ${money(netSavings)} (${(goalRate*100).toFixed(1)}% of income). ${progress.length} of ${activeGoals.length} active goals have a positive balance.`;}}
 add('Savings & goals',savingsStatus,savingsDetail,'piggy-bank');
 const emergency=goalsBefore.find(g=>g.isEmergencyFund===true),cash=currentEstimatedCash();let resilienceStatus='Insufficient data',resilienceDetail='Available cash could not be estimated reliably.';
 if(cash!==null){resilienceStatus=cash<0?'At risk':cash===0?'Needs attention':'Healthy';resilienceDetail=`Your current available cash is ${money(cash)}. Review your current cash position and immediate obligations.`;if(emergency)resilienceDetail+=` Current designated emergency fund balance: ${money(goalBalanceAt(emergency.id,todayKey))}.`;}else if(emergency){resilienceDetail=`Current available cash could not be estimated. Current designated emergency fund balance: ${money(goalBalanceAt(emergency.id,todayKey))}.`;}
 add('Financial resilience',resilienceStatus,resilienceDetail,'shield-check');
 const judged=health.filter(x=>x.status!=='Insufficient data'),risk=judged.filter(x=>x.status==='At risk').length,attention=judged.filter(x=>x.status==='Needs attention').length;
 let overall='Insufficient data',overallText='Not enough reliable indicators are available to make an overall assessment.';
 if(judged.length>=3){if(risk>=1){overall='At risk';overallText='One or more indicators show a significant financial concern. Review the details below.';}else if(attention>=1){overall='Needs attention';overallText='Some areas could use improvement. Review the details below.';}else{overall='Healthy';overallText='Your assessed indicators are within the initial healthy ranges based on the records available.';}}
 const cls=v=>v==='Healthy'?'good':v==='Needs attention'?'warn':v==='At risk'?'bad':'';
 root.innerHTML=`<div class="financialHealthTop"><div><div class="label">${year} assessment · ${isCurrentYear?'current year to date':'selected historical year'}</div><h2 class="financialHealthStatus ${cls(overall)}">${overall}</h2><p class="mini">${overallText}</p></div><span class="pill">${judged.length} of ${health.length} indicators assessed</span></div><div class="financialHealthGrid">${health.map(h=>`<div class="financialHealthItem"><div class="financialHealthItemHead"><b>${h.name}</b><span class="healthStatus ${cls(h.status)}">${h.status}</span></div><div class="mini">${h.detail}</div></div>`).join('')}</div><div class="notice financialHealthNote">Method: statuses use recorded figures, not a score. Current debt balances, current scheduled bills, and current available cash are labeled as current. Historical bill status uses records available for the selected year. Missing data is not treated as zero.</div>`;
}

function renderData(){$('installedVersion').textContent=APP_VERSION;$('startCashDate').max=localDateKey(today);$('currency').value=db.settings.currency;$('startCash').value=db.settings.startingCash;$('startCashDate').value=db.settings.startingCashDate||'';$('saveTarget').value=db.settings.saveTarget;$('incomeGrowth').value=db.settings.incomeGrowth;renderAppearanceSettings();}

function estimatedDailyInterest(d){return debtCurrentBalance(d)*(Math.max(0,+d?.apr||0)/100)/365}
function renderDebts(){
  if(!restoreVerificationMode)recalculateDebtLedgers();
  let bal=db.debts.reduce((s,x)=>s+debtCurrentBalance(x),0),pay=debtPayments(),dailyInterest=db.debts.reduce((s,x)=>s+estimatedDailyInterest(x),0),accrued=db.debts.reduce((s,x)=>s+(+x.accruedInterest||0),0);
  $('debtCards').innerHTML=[['Debt balance',money(bal)],['Monthly payment',money(pay)],['Est. daily interest',money(dailyInterest)],['Accrued interest',money(accrued)]].map(a=>`<div class="card"><div class="label">${a[0]}</div><div class="metric">${a[1]}</div></div>`).join('');
  $('debtTable').innerHTML=db.debts.map(d=>{let p=payoff(d);return `<tr><td><b>${esc(d.name)}</b><br><span class="mini">${esc(d.type)}${d.status==='paid-off'?' · Paid off':d.status==='archived'?' · Archived':''}</span></td><td>${money(debtCurrentBalance(d))}</td><td>${(+d.apr).toFixed(2)}%</td><td>${money(d.minimum)}</td><td>${money(d.extra)}</td><td>${p.date}</td><td>${money(estimatedDailyInterest(d)*30)}</td><td><button class="btn small" onclick="openModal('debtEdit',db.debts.find(x=>x.id==='${d.id}'))">Edit</button> <button class="btn small danger" onclick="remove('debts','${d.id}')">${debtLinkedTransactions(d.id).length?'Archive':'Delete'}</button></td></tr>`}).join('')||'<tr><td colspan="8" class="empty">No debts.</td></tr>';
  const debtRows=db.debts.filter(d=>!['paid-off','archived'].includes(d.status)&&debtCurrentBalance(d)>0).sort((a,b)=>debtCurrentBalance(b)-debtCurrentBalance(a)).map(d=>({name:d.name,amount:debtCurrentBalance(d),apr:d.apr,minimum:d.minimum}));canvas('debtChart','hbars',debtRows);
  $('strategy').innerHTML=`<div class="notice">Debt-linked payments are calculated using daily interest accrual: principal × APR ÷ 365 × days elapsed. Each payment is applied to accrued interest first, then principal. The allocation is an estimate; the lender's actual balance, fees, compounding, and payment timing remain authoritative.</div>`;
  const box=$('debtPaymentHistory'); if(box)box.innerHTML=db.debts.map(d=>{let rows=debtPaymentRows(d);return `<div class="section"><div class="sectionhead"><div><h3 style="margin:0">${esc(d.name)}</h3><div class="mini">Payment history · principal balance ${money(debtCurrentBalance(d))}</div></div></div>${rows.length?`<div class="tablewrap"><table class="table"><thead><tr><th>Date</th><th>Payment</th><th>Interest</th><th>Principal</th><th>Balance</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${dateText(r.date)}</td><td>${money(r.amount)}</td><td>${money(r.interestPaid)}</td><td>${money(r.principalPaid)}</td><td>${money(r.remainingPrincipal)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No debt-linked payments yet.</div>'}</div>`}).join('')||'<div class="empty">No debt accounts added.</div>';
}

function renderGoals(){
  $('goalList').innerHTML=db.goals.map(g=>{
    const saved=goalBalance(g.id),target=+g.target||0,p=target?Math.min(100,Math.max(0,saved/target*100)):0,remaining=Math.max(0,target-saved),fcast=goalForecast(g),archived=g.status==='archived';
    let forecastLine='';
    if(fcast.status==='Ahead'||fcast.status==='On track'||fcast.status==='Behind')forecastLine=`<div class="goalForecast ${fcast.status==='Ahead'||fcast.status==='On track'?'good':'bad'}"><b>${esc(fcast.status)}</b><span>Required pace: ${money(fcast.required)}/mo · Actual pace: ${money(fcast.actual)}/mo</span>${fcast.completion?`<span>Estimated completion: ${dateText(fcast.completion)}</span>`:''}<span class="mini">Forecast uses net Savings transactions from the last 3 months (withdrawals reduce the pace). Required pace is remaining ÷ months until target date.</span></div>`;
    else forecastLine=`<div class="goalForecast mini"><b>${esc(fcast.status)}</b><span>${esc(fcast.message||'')}</span>${fcast.required!=null?`<span>Required pace: ${money(fcast.required)}/mo</span>`:''}<span>Forecast method: last 3 months of actual net Savings activity.</span></div>`;
    return `<div class="card goalCard"><div class="sectionhead"><div><b>${esc(g.name)}</b><div class="mini">${archived?'Archived':'Active'}${g.isEmergencyFund?' · Emergency fund':''}${saved>=target&&target>0?' · Goal reached':''}</div></div><span></span></div><div class="label">${money(saved)} of ${money(target)}${g.targetDate?' · Target '+dateText(g.targetDate):''}</div><div class="progress section"><div class="bar" style="width:${p}%"></div></div><div class="split section mini"><span>${p.toFixed(0)}%</span><span>${money(remaining)} remaining</span></div>${forecastLine}<div class="toolbar section"><button class="btn small primary" onclick="openGoalTransaction('${g.id}',1)">+ Add Savings</button><button class="btn small" onclick="openGoalTransaction('${g.id}',-1)">− Withdraw</button><button class="btn small" onclick="openModal('goalEdit',db.goals.find(x=>x.id==='${g.id}'))">Edit</button>${archived?`<button class="btn small" onclick="setGoalArchive('${g.id}',false)">Unarchive</button>`:`<button class="btn small" onclick="setGoalArchive('${g.id}',true)">Archive</button>`}<button class="btn small danger" onclick="remove('goals','${g.id}')">Delete</button></div></div>`;
  }).join('')||'<div class="empty">No goals.</div>';
}



function renderReports(){
  const p=forecast(),currentCash=currentEstimatedCash();
  const twelveIncome=p.reduce((s,x)=>s+x.inc,0);
  const twelveOutflow=p.reduce((s,x)=>s+(x.b||0)+(x.projectedOutflowSpending||0)+x.knownTransactions+x.savings+x.investments,0);
  const twelveNet=twelveIncome-twelveOutflow;
  const ending=p[p.length-1]?.cash;
  $('reportCards').innerHTML=[
    ['Current estimated cash',currentCash===null?'—':money(currentCash)],
    ['12-month income',money(twelveIncome)],
    ['12-month outflow',money(twelveOutflow)],
    ['12-month net',money(twelveNet)],
    ['Ending cash',ending==null?'—':money(ending)]
  ].map(x=>`<div class="card"><div class="label">${x[0]}</div><div class="metric">${x[1]}</div></div>`).join('');
  canvas('incomeOutChart','forecast',p.map(x=>({l:x.key.slice(5),key:x.key,inc:x.inc,projectedSpending:x.projectedOutflowSpending,actualSpent:x.actualSpent,remainingSpending:x.sp,knownBills:x.b,knownTransactions:x.knownTransactions,savings:x.savings,investments:x.investments,cash:x.cash,net:x.net})));
  canvas('projectionChart','line',p.map((x,i)=>({l:x.key.slice(5),key:x.key,v:x.projectedSavings,projectedSavings:x.projectedSavings,inc:x.inc,projectedSpending:x.projectedOutflowSpending,actualSpent:x.actualSpent,remainingSpending:x.sp,knownBills:x.b,knownTransactions:x.knownTransactions,savings:x.savings,investments:x.investments,cash:x.cash,net:x.net})));
  const period=$('forecastView')?.value||'monthly',rows=aggregateForecast(p,period);
  $('forecastTable').innerHTML=rows.map(x=>{
    const starting=x.startCash!=null?x.startCash:(x.cash!=null&&x.net!=null?x.cash-x.net:null);
    const ordinary=x.projectedSpending==null?null:x.projectedSpending;
    const actual=x.actualSpent==null?null:x.actualSpent;
    return `<tr><td>${esc(x.label||x.key)}</td><td>${starting==null?'—':money(starting)}</td><td>${money(x.inc)}</td><td>${ordinary==null?'—':money(ordinary)}</td><td>${actual==null?'—':money(actual)}</td><td>${x.sp==null?'—':money(x.sp)}</td><td>${money(x.b)}</td><td>${money(x.knownTransactions)}</td><td>${money(x.savings)}</td><td>${money(x.investments)}</td><td class="${(x.projectedSavings||0)>=0?'good':'bad'}">${x.projectedSavings==null?'—':money(x.projectedSavings)}</td></tr>`;
  }).join('');
}
function render(){let p=document.querySelector('.page.active')?.id||'dashboard';if(p==='dashboard')renderDashboard();if(p==='annual')renderAnnual();if(p==='plan')renderPlan();if(p==='transactions')renderTransactions();if(p==='bills')renderBills();if(p==='budgets')renderBudgets();if(p==='debts')renderDebts();if(p==='goals')renderGoals();if(p==='reports')renderReports();if(p==='data')renderData()}
function remove(type,id){
 if(type==='goals'){
   const g=db.goals.find(x=>x.id===id);if(!g)return;
   const linkedTx=goalTransactions(id).length,linkedAlloc=db.assignments.filter(a=>a.type==='savings'&&String(a.targetId)===String(id)).length;
   if(linkedTx||linkedAlloc){
     const warning=`Permanently delete “${g.name}”?\n\nThis goal has ${linkedTx?linkedTx+' linked Savings transaction'+(linkedTx===1?'':'s'):''}${linkedTx&&linkedAlloc?' and ':''}${linkedAlloc?linkedAlloc+' Paycheck Plan allocation'+(linkedAlloc===1?'':'s'):''}.\n\nThe goal itself will be deleted, but the historical Savings transactions and Paycheck Plan allocations will NOT be deleted. They will remain as historical records and may show “Target no longer exists.”\n\nThis cannot be undone. Continue?`;
     if(!confirm(warning))return;
   }else if(!confirm(`Permanently delete “${g.name}”?\n\nThis goal has no linked historical activity. This cannot be undone.`))return;
 }
 if(type==='debts'){
   const d=db.debts.find(x=>String(x.id)===String(id));if(!d)return;
   const linked=debtLinkedTransactions(id);
   if(linked.length){if(!confirm(`Archive “${d.name}”?\n\nThis debt has ${linked.length} linked transaction${linked.length===1?'':'s'}. Archiving keeps the debt and its payment history intact. It will no longer be offered for new transactions.`))return;d.status='archived';d.updatedAt=localDateKey(today);save();render();return;}
   if(!confirm(`Delete “${d.name}”?\n\nThis debt has no linked payment transactions. This cannot be undone.`))return;
   db.debts=db.debts.filter(x=>String(x.id)!==String(id));save();render();return;
 }
 if(type==='goals'){const g=db.goals.find(x=>x.id===id);if(g){db.deletedGoalHistory=db.deletedGoalHistory||[];db.deletedGoalHistory=db.deletedGoalHistory.filter(x=>x.id!==id);db.deletedGoalHistory.push({id:g.id,name:g.name,target:g.target,targetDate:g.targetDate||'',startingBalance:Number.isFinite(+g.startingBalance)?+g.startingBalance:0,startingTransactions:Array.isArray(g.startingTransactions)?g.startingTransactions.map(x=>({...x})):[],createdAt:g.createdAt||localDateKey(today),deletedAt:localDateKey(today)});}}db[type]=db[type].filter(x=>x.id!==id);save();render()
}

function f(label,name,type='text',value='',extra=''){return `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`}
function s(label,name,opts,value=''){return `<div class="field"><label>${label}</label><select name="${name}">${opts.map(o=>`<option value="${esc(o)}" ${o===value?'selected':''}>${esc(o)}</option>`).join('')}</select></div>`}
function unpaidBillOptions(selected=''){ensureBillOccurrences();let sid=String(selected||'');return db.billOccurrences.filter(o=>{const b=getBill(o.billId);if(!b)return false;const isSelected=String(o.id)===sid;if(isSelected)return true;if(b.active===false||o.superseded)return false;return occurrenceDisplayStatus(o)!=='paid';}).sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).slice(0,150)}
function refreshBillFormVisibility(){let form=$('modalForm');if(!form||!['bill','billEdit'].includes(form.dataset.type))return;let bt=form.querySelector('[name="billType"]')?.value,at=form.querySelector('[name="amountType"]')?.value;let freq=form.querySelector('[name="frequency"]')?.closest('.field');if(freq)freq.style.display=bt==='one-time'?'none':'';let notice=form.querySelector('.notice');if(notice)notice.textContent=at==='variable'?'Expected amount is a planning estimate. The actual payment amount is recorded when the bill is paid.':'Fixed bills still allow the actual payment amount to be edited when paid. Changes to an existing bill apply to future unpaid occurrences; paid history and transactions stay unchanged.'}
function closeModal(){
  const back=$('modalBack');
  const form=$('modalForm');
  if(back)back.classList.remove('show');
  if(form){form.reset?.();form.innerHTML='';delete form.dataset.type;delete form.dataset.editId;delete form.dataset.occurrenceId;}
  if($('modalTitle'))$('modalTitle').textContent='';
}
window.closeModal=closeModal;
window.openModal=openModal;window.db=db;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('modalBack')?.classList.contains('show'))closeModal()});

function paycheckOccurrenceEligibleForTransaction(o,transactionDate,selected=''){
  if(!o||o.status==='cancelled')return false;
  const linkedTransaction=o.transactionId?db.transactions.find(t=>t.id===o.transactionId&&t.type==='income'):null;
  // Preserve an existing historical link while editing that same transaction; do not offer it for new links.
  if(selected&&o.id===selected&&linkedTransaction)return true;
  const schedule=getPaycheckSchedule(o.paycheckId);
  if(!schedule||schedule.active===false||!transactionDate)return false;
  // An income transaction may link only to an occurrence scheduled on or before its actual transaction date.
  return /^\d{4}-\d{2}-\d{2}$/.test(transactionDate)&&o.scheduledDate<=transactionDate&&!o.transactionId;
}
function paycheckOccurrenceOptions(selected='',transactionDate=localDateKey(today)){
  generatePaycheckOccurrences();
  return db.paycheckOccurrences.filter(o=>paycheckOccurrenceEligibleForTransaction(o,transactionDate,selected))
    .sort((a,b)=>a.scheduledDate.localeCompare(b.scheduledDate))
    .slice(-150).map(o=>{let p=getPaycheckSchedule(o.paycheckId);return `<option value="${o.id}" ${o.id===selected?'selected':''}>${esc(p?.name||'Paycheck')} — ${dateText(o.scheduledDate)} — ${money(paycheckOccurrenceAmount(o))}</option>`}).join('')
}
function transactionDebtOptions(selected=''){const sid=String(selected||'');return db.debts.filter(d=>d.status==='active'||String(d.id)===sid).sort((a,b)=>String(a.name).localeCompare(String(b.name))).map(d=>`<option value="${esc(d.id)}" ${String(d.id)===sid?'selected':''}>${esc(d.name)}${d.status==='paid-off'?' — Paid off':d.status==='archived'?' — Archived':''}</option>`).join('')}
function openModal(type,preset=null){let title='',body='';
if(type==='transaction'||type==='transactionEdit'){let t=preset||{},edit=type==='transactionEdit',title=edit?'Edit transaction':'Add transaction',selectedType=t.type||'expense';body=`<div class="formgrid">${f('Date','date','date',t.date||iso(today),'required')}${s('Type','type',['expense','bill','income','savings','investment'],selectedType)}${f('Description','description','text',t.description||t.payee||'','required placeholder="e.g. Groceries, Electric, City paycheck"')}${f('Amount','amount','number',t.amount??'','required min="0.01" step=".01"')}${s('Category','category',db.categories,t.category||'Other')}${f('Account (optional)','account','text',t.account||'','placeholder="Checking"')}${f('Notes','note', 'text', t.note||'')}<div class="field" data-tx-debt><label>Debt Relationship (optional)</label><select name="debtId"><option value="">Not linked</option>${transactionDebtOptions(t.debtId||'')}</select></div><div class="field" data-tx-goal><label>Savings goal (optional)</label><select name="goalId"><option value="">Not linked</option>${db.goals.map(g=>`<option value="${g.id}" ${String(t.goalId||'')===String(g.id)?'selected':''}>${esc(g.name)}</option>`).join('')}</select></div><div class="field" data-tx-bill><label>Bill occurrence</label><select name="billOccurrenceId"><option value="">${edit?'Not linked':'None'}</option></select></div><div class="field" data-tx-paycheck><label>Paycheck occurrence (optional)</label><select name="paycheckOccurrenceId"><option value="">Not linked</option></select></div><div class="full mini transactionTypeNotice">Expense = regular spending. Bill = an actual bill payment from Bills &amp; Calendar. Income = actual money received. Savings = money moved into savings. Investment = money contributed to investments. Savings and Investment transactions are not counted as spending. Paycheck Plan is only a plan; confirm the deposit to create the Income transaction.</div><div class="full"><button class="btn primary" type="submit">${edit?'Save Changes':'Save Transaction'}</button></div></div>`}

if(type==='bill'||type==='billEdit'){let b=preset||{};title=type==='billEdit'?'Edit Bill':'Add Bill';let freq=b.frequency||'monthly',bt=b.billType||'recurring',at=b.amountType||'fixed';body=`<div class="formgrid"><div class="full"><h3 style="margin:0">Basic Information</h3></div>${f('Bill name','name','text',b.name||'','required placeholder="Rent"')}${s('Category','category',db.categories,b.category||'Housing')}${s('Bill type','billType',['recurring','one-time'],bt)}<div class="full"><h3 style="margin:8px 0 0">Amount</h3></div>${s('Amount type','amountType',['fixed','variable'],at)}${f('Expected amount','expectedAmount','number',b.expectedAmount??b.amount??'','required min="0" step=".01"')}<div class="full"><h3 style="margin:8px 0 0">Schedule</h3></div>${f('First due date','startDate','date',b.startDate||iso(today),'required')}${s('Frequency','frequency',['weekly','biweekly','monthly','quarterly','semiannual','annual'],freq)}<div class="full"><h3 style="margin:8px 0 0">Payment</h3></div>${s('Autopay','autopay',['no','yes'],b.autopay?'yes':'no')}<div class="field"><label>Debt Relationship (optional)</label><select name="debtId"><option value="">Not linked</option>${transactionDebtOptions(b.debtId||'')}</select></div>${f('Notes','notes','text',b.notes||'','placeholder="Optional bill notes"')}${type==='billEdit'?`${s('Status','active',['active','inactive'],b.active===false?'inactive':'active')}`:''}<div class="full"><div class="notice">${at==='variable'?'Expected amount is a planning estimate. The actual payment amount is recorded when the bill is paid.':'Fixed bills still allow the actual payment amount to be edited when paid.'} Changes to an existing bill apply to future unpaid occurrences; paid history and transactions stay unchanged.</div></div><div class="full"><button class="btn primary" type="submit">${type==='billEdit'?'Save Changes':'Create Bill'}</button></div></div>`}
if(type==='paycheck'||type==='paycheckEdit'){let p=preset||{},edit=type==='paycheckEdit';title=edit?'Edit paycheck schedule':'Add paycheck schedule';let freq=p.frequency||'biweekly',custom=Array.isArray(p.customDates)?p.customDates.join(', '):'';body=`<div class="formgrid">${f('Name','name','text',p.name||'','required placeholder="City paycheck"')}${f('Expected amount','expectedAmount','number',p.expectedAmount??p.amount??'','required min="0.01" step=".01"')}${s('Frequency','frequency',['weekly','biweekly','semimonthly','monthly','quarterly','one-time','custom'],freq)}${f('First date','firstDate','date',p.firstDate||p.date||iso(today),'required')}${f('Second pay day (semi-monthly)','secondDay','number',p.secondDay||15,'min="2" max="31"')}<div class="field full"><label>Custom dates (custom frequency only)</label><input name="customDates" value="${esc(custom)}" placeholder="YYYY-MM-DD, YYYY-MM-DD"></div>${edit?s('Status','active',['active','inactive'],p.active===false?'inactive':'active'):''}<div class="full"><div class="notice">Scheduled money is not actual income. Each occurrence stays separate so schedule changes affect future occurrences without rewriting history.</div></div><div class="full"><button class="btn primary" type="submit">${edit?'Save Changes':'Create Schedule'}</button></div></div>`}
if(type==='assignment'||type==='assignmentEdit'){openAllocationEditor(type==='assignmentEdit'?preset:null);return}
if(type==='budget'||type==='budgetEdit'){let b=preset||{},edit=type==='budgetEdit';title=edit?'Edit budget':'Add budget';let effective=edit?(b.effectiveMonth||currentMonth()):(budgetViewMonth>=currentMonth()?budgetViewMonth:currentMonth());body=`<div class="formgrid">${s('Category','category',db.categories,b.category||'Groceries')}${f('Monthly budget','amount','number',edit?(b.amount??''):'','required min="0" step=".01"')}${f('Effective from','effectiveMonth','month',effective,`required min="${currentMonth()}"`)}<div class="full"><div class="notice">Budgets repeat automatically each month until you change them. Earlier months keep their original budget history. Budgets are plans only; actual spending comes from Transactions.</div></div><div class="full"><button class="btn primary" type="submit">${edit?'Save Changes':'Save Budget'}</button></div></div>`}
if(type==='debt'||type==='debtEdit'){let d=preset||{},edit=type==='debtEdit';title=edit?'Edit debt':'Add debt';body=`<div class="formgrid">${f('Debt name','name', '',d.name||'','required')}${s('Type','type',['Credit Card','Auto Loan','Personal Loan','Student Loan','Mortgage','Medical','Other'],d.type||'Other')}${edit?f('Starting balance','startingBalance','number',d.startingBalance??d.balance??'','required min="0" step=".01" disabled'):f('Balance','balance','number','','required min="0" step=".01"')}${f('APR %','apr','number',d.apr??'','required min="0" step=".01"')}${f('Minimum payment','minimum','number',d.minimum??'','required min="0" step=".01"')}${f('Extra payment','extra','number',d.extra??0,'min="0" step=".01"')}${f('Start date','startDate', 'date',d.startDate||d.createdAt||iso(today),`required max="${iso(today)}"`)}${edit?'<div class="full mini">Starting balance is preserved as the original amount. Actual payments and balance changes are handled by linked Transactions.</div>':''}<div class="full"><button class="btn primary" type="submit">${edit?'Save Changes':'Save debt'}</button></div></div>`}
if(type==='goal'||type==='goalEdit'){let g=preset||{},edit=type==='goalEdit',startingSources=Array.isArray(g.startingTransactions)?g.startingTransactions:[],eligible=edit?[]:eligibleGoalStartingTransactions();title=edit?'Edit savings goal':'Create savings goal';body=`<div class="formgrid">${f('Goal name','name','text',g.name||'','required')}${f('Target amount','target','number',g.target??'','required min="0" step=".01"')}${f(edit?'Additional starting balance':'Other starting balance (optional)','startingBalance','number',g.startingBalance??0,`min="0" step=".01" ${edit&&(goalTransactions(g.id).length||startingSources.length)?'disabled':''}`)}${f('Target date','targetDate','date',g.targetDate||g.date||'')}${!edit?`<div class="field full"><label>Use existing Savings transactions as starting balance</label><div style="max-height:190px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px;display:grid;gap:8px">${eligible.length?eligible.map(t=>`<label class="switch"><input type="checkbox" name="startingTransactionIds" value="${esc(t.id)}"><span>${dateText(t.date)} — ${esc(transactionDescription(t))} — <b>${money(t.amount)}</b></span></label>`).join(''):'<span class="mini">No unassigned Savings transactions are available.</span>'}</div><div class="mini">Select one or more unassigned Savings transactions. Their amounts will be included in the starting balance and will not be counted twice.</div></div>`:startingSources.length?`<div class="full notice"><b>Starting Savings transactions</b><br>${startingSources.map(x=>`${esc(x.date)} — ${esc(x.description)} — ${money(x.amount)}`).join('<br>')}</div>`:''}${edit?s('Status','status',['active','archived'],g.status==='archived'?'archived':'active'):''}<div class="field full"><label>Emergency fund designation</label><select name="isEmergencyFund"><option value="false" ${g.isEmergencyFund===true?'':'selected'}>No — ordinary savings goal</option><option value="true" ${g.isEmergencyFund===true?'selected':''}>Yes — use this goal as my emergency fund</option></select></div><div class="full"><div class="notice">${edit?'Starting balance sources are preserved.':'Starting balance can include existing Savings transactions and any additional amount entered above.'} Future Savings transactions increase or reduce the goal only when explicitly linked to it. Only one goal can be designated as the emergency fund.</div></div><div class="full"><button class="btn primary" type="submit">${edit?'Save Changes':'Create goal'}</button></div></div>`}
if(type==='goalTransaction'){let g=db.goals.find(x=>x.id===preset?.goalId),dir=preset?.direction===-1?-1:1;title=dir===1?'Add savings':'Withdraw from savings';body=`<div class="formgrid">${f('Date','date','date',iso(today),`required max="${localDateKey(today)}"`)}${f('Amount','amount','number','','required min="0.01" step=".01"')}${f('Description','description','text',dir===1?'Savings contribution':'Savings withdrawal','required')}${f('Notes','note','text','','placeholder="Optional"')}<div class="full"><div class="notice">${esc(g?.name||'Goal')} · ${dir===1?'This creates a Savings transaction linked to the goal.':'This creates a negative Savings transaction linked to the goal.'}</div></div><div class="full"><button class="btn primary" type="submit">${dir===1?'Add Savings':'Record Withdrawal'}</button></div></div>`}


$('modalTitle').textContent=title;$('modalForm').innerHTML=body;$('modalForm').dataset.type=type;if(preset)$('modalForm').dataset.editId=preset.id;if(type==='goalTransaction'){ $('modalForm').dataset.goalId=preset.goalId; $('modalForm').dataset.direction=String(preset.direction||1); }if(type==='transaction'||type==='transactionEdit'){let form=$('modalForm'),typeEl=form.querySelector('[name="type"]'),billEl=form.querySelector('[name="billOccurrenceId"]'),catEl=form.querySelector('[name="category"]'),goalEl=form.querySelector('[name="goalId"]');if(catEl)catEl.closest('.field').dataset.txCategory='1';if(billEl){let selected=preset?.billOccurrenceId||'';let billField=billEl.closest('[data-tx-bill]');if(billField){billField.outerHTML=`<div class="field" data-tx-bill><label>Bill occurrence</label><select name="billOccurrenceId"><option value="">${type==='transactionEdit'?'Not linked':'None'}</option>${unpaidBillOptions(selected).map(o=>{let b=getBill(o.billId),paid=occurrenceDisplayStatus(o)==='paid';return `<option value="${o.id}" ${o.id===selected?'selected':''}>${esc(b?.name||'Bill')} — ${dateText(o.dueDate)}${paid?' — Paid':''}</option>`}).join('')}</select></div>`}}let sync=()=>{let v=typeEl?.value,bd=form.querySelector('[data-tx-bill]'),pd=form.querySelector('[data-tx-paycheck]'),dd=form.querySelector('[data-tx-debt]'),dateEl=form.querySelector('[name="date"]');if(bd)bd.style.display=v==='bill'?'':'none';if(pd)pd.style.display=v==='income'?'':'none';if(dd)dd.style.display=(v==='expense'||v==='bill'||(dd.querySelector('[name=debtId]')?.value||''))?'':'none';if(goalEl)goalEl.closest('.field').style.display=v==='savings'?'':'none';if(catEl)catEl.closest('.field').style.display=v==='income'?'none':'';if(v==='income'&&pd){let sel=pd.querySelector('select'),selected=sel?.value||preset?.paycheckOccurrenceId||'',txDate=dateEl?.value||localDateKey(today);if(sel)sel.innerHTML='<option value="">Not linked</option>'+paycheckOccurrenceOptions(selected,txDate);if(sel&&selected&&[...sel.options].some(opt=>opt.value===selected))sel.value=selected;}};typeEl?.addEventListener('change',sync);form.querySelector('[name="date"]')?.addEventListener('change',sync);sync();}if(type==='bill'||type==='billEdit'){refreshBillFormVisibility();$('modalForm').querySelector('[name="billType"]')?.addEventListener('change',refreshBillFormVisibility);$('modalForm').querySelector('[name="amountType"]')?.addEventListener('change',refreshBillFormVisibility)}if(type==='assignment'||type==='assignmentEdit'){let form=$('modalForm'),typeEl=form.querySelector('[name="type"]'),targetEl=form.querySelector('[name="targetId"]'),labelEl=form.querySelector('[name="label"]'),targetWrap=form.querySelector('[data-allocation-target-wrap]');const targetOptions=()=>{let v=typeEl?.value||'other',opts='',selected=String(form.dataset.targetId||'');if(v==='bill'){ensureBillOccurrences();opts=db.billOccurrences.filter(o=>billOccurrenceCountsAsObligation(o)).sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).slice(0,150).map(o=>{let b=getBill(o.billId);return `<option value="${o.id}">${esc(b?.name||'Bill')} — ${dateText(o.dueDate)} — ${money(o.expectedAmount)}</option>`}).join('')}else if(v==='category'){opts=db.categories.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}else if(v==='debt'){opts=db.debts.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('')}else if(v==='savings'){opts=db.goals.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}else if(v==='investment'&&selected){opts=`<option value="${esc(selected)}">${esc(a0.label||'Investment allocation')} — Legacy allocation</option>`}if(targetEl){if(selected&&![...targetEl.options].some(x=>x.value===selected)){opts=`<option value="${esc(selected)}">${esc(a0.label||'Target')} — Target no longer exists</option>`+opts}targetEl.innerHTML=opts||'<option value="">No targets available</option>';if(selected&&[...targetEl.options].some(x=>x.value===selected))targetEl.value=selected;targetWrap.style.display=v==='other'?'none':'';targetEl.disabled=v==='other'||!opts;labelEl.closest('.field').style.display=v==='other'||v==='category'?'':'none';if(v==='category'&&opts)labelEl.value=targetEl.options[targetEl.selectedIndex]?.text||'';else if(v!=='other'&&opts)labelEl.value=targetEl.options[targetEl.selectedIndex]?.text||'';else if(v==='other'&&!labelEl.value)labelEl.value='Other';}};typeEl?.addEventListener('change',targetOptions);targetEl?.addEventListener('change',()=>{if(typeEl.value!=='other'&&targetEl.selectedOptions[0])labelEl.value=targetEl.selectedOptions[0].text});form.dataset.targetId=String(preset?.targetId||'');targetOptions();} $('modalBack').classList.add('show')}
$('modalBack').onclick=e=>{if(e.target===$('modalBack'))closeModal()};
$('modalForm').onsubmit=e=>{e.preventDefault();let t=e.target.dataset.type,o=Object.fromEntries(new FormData(e.target).entries());if(t==='goal')o.startingTransactionIds=[...e.target.querySelectorAll('input[name="startingTransactionIds"]:checked')].map(x=>x.value);
 if(t==='linkBill'){let txId=e.target.dataset.txId,occId=o.billOccurrenceId;if(!occId)return alert('Select a bill occurrence.');if(linkTransactionToBill(txId,occId))closeModal();return}
 if(t==='transaction'||t==='transactionEdit'){
   let editId=e.target.dataset.editId,tx=editId?db.transactions.find(x=>x.id===editId):null;
   let type=o.type,amount=+o.amount;
   if(type==='savings'&&o.goalId&& !db.goals.find(g=>g.id===o.goalId))return alert('The selected Savings goal no longer exists. Choose an active goal.');
   if(!o.date||!o.description?.trim()||!Number.isFinite(amount)||amount<=0)return alert('Enter a valid date, description, and positive amount.');
   if(type==='savings'&&o.date>localDateKey(today))return alert('Savings transactions represent actual money movement and cannot be dated in the future. Use today or an earlier date.');
   if(type==='bill'&&!o.billOccurrenceId&&!tx?.billOccurrenceId)return alert('Bill transactions must be linked to a bill occurrence.');
   if(type==='income'&&o.billOccurrenceId)return alert('Income transactions cannot be linked to bills.');
   if(type==='income'&&o.paycheckOccurrenceId&&!paycheckOccurrenceEligibleForTransaction(getPaycheckOccurrence(o.paycheckOccurrenceId),o.date,tx?.paycheckOccurrenceId||''))return alert('Choose an eligible paycheck occurrence for this income transaction date. Inactive schedules and future occurrences cannot be linked to a new income transaction.');
   if(o.debtId&&!db.debts.some(d=>String(d.id)===String(o.debtId)))return alert('The selected debt no longer exists. Choose another debt or remove the relationship.');
   if(o.debtId&&!['expense','bill'].includes(type))return alert('Debt relationships can only be used with Expense or Bill transactions.');
   if(o.debtId){let linkedDebt=db.debts.find(d=>String(d.id)===String(o.debtId));if(linkedDebt&&o.date<String(linkedDebt.startDate||linkedDebt.createdAt||''))return alert(`Debt payments cannot be dated before ${dateText(linkedDebt.startDate||linkedDebt.createdAt)}.`);}
   if(!['expense','bill','income','savings','investment'].includes(type))return alert('Choose a valid transaction type.');
   if(type==='bill'){let occId=o.billOccurrenceId||tx?.billOccurrenceId,occ=getOccurrence(occId);if(!occ||!getBill(occ.billId))return alert('The selected bill occurrence is no longer available.');}
   if(tx){let oldOcc=tx.billOccurrenceId,oldType=tx.type;tx.date=o.date;tx.type=type;tx.description=o.description.trim();tx.amount=amount;tx.category=type==='income'?'':o.category||'Other';tx.account=o.account||'';tx.note=o.note||'';tx.debtId=o.debtId||null;tx.goalId=type==='savings'?(o.goalId||null):null;if(oldOcc&&type!=='bill')unlinkTransactionFromBill(tx);if(type==='bill'){let occId=o.billOccurrenceId||oldOcc;if(oldOcc&&oldOcc!==occId)unlinkTransactionFromBill(tx);tx.billOccurrenceId=occId;let occ=getOccurrence(occId);if(!occ)return alert('The selected bill occurrence no longer exists.');tx.debtId=occ.debtId||getBill(occ.billId)?.debtId||o.debtId||null;if(tx.debtId&&!debtPaymentDateValid(tx.debtId,tx.date)){let d=db.debts.find(x=>String(x.id)===String(tx.debtId));return alert(`This bill payment cannot be dated before ${dateText(debtStartDate(d))}.`)}occ.payments=occ.payments||[];if(!occ.payments.includes(tx.id))occ.payments.push(tx.id);syncBillOccurrence(occId)}else delete tx.billOccurrenceId;if(oldType==='income'&&tx.paycheckOccurrenceId&&type!=='income')unlinkTransactionFromPaycheck(tx);if(type==='income'){if(o.paycheckOccurrenceId&&!linkTransactionToPaycheck(tx,o.paycheckOccurrenceId))return;else if(!o.paycheckOccurrenceId&&tx.paycheckOccurrenceId)unlinkTransactionFromPaycheck(tx)}else delete tx.paycheckOccurrenceId;}
   else {tx={id:uid(),date:o.date,type,description:o.description.trim(),amount,category:type==='income'?'':o.category||'',account:o.account||'',note:o.note||'',debtId:o.debtId||null,goalId:type==='savings'?(o.goalId||null):null};if(type==='income'&&o.paycheckOccurrenceId){let po=getPaycheckOccurrence(o.paycheckOccurrenceId);if(po?.transactionId){return alert('That paycheck occurrence already has an Income transaction.')}tx.paycheckOccurrenceId=o.paycheckOccurrenceId;if(po){po.transactionId=tx.id;po.actualDate=tx.date;po.actualAmount=tx.amount;po.status='deposited'}}if(type==='bill'){tx.billOccurrenceId=o.billOccurrenceId;let occ=getOccurrence(o.billOccurrenceId);if(!occ)return alert('The selected bill occurrence no longer exists.');tx.debtId=occ.debtId||getBill(occ.billId)?.debtId||tx.debtId||null;if(tx.debtId&&!debtPaymentDateValid(tx.debtId,tx.date)){let d=db.debts.find(x=>String(x.id)===String(tx.debtId));return alert(`This bill payment cannot be dated before ${dateText(debtStartDate(d))}.`)}occ.payments=occ.payments||[];occ.payments.push(tx.id)}db.transactions.push(tx);if(type==='bill')syncBillOccurrence(tx.billOccurrenceId)}
   recalculateDebtLedgers();save();closeModal();render();return;
 }
 if(t==='payment'){let occ=getOccurrence(e.target.dataset.occurrenceId),b=occ&&getBill(occ.billId);if(!occ||!b)return;let amt=+o.amount;if(!Number.isFinite(amt)||amt<=0)return alert('Enter a valid payment amount.');let debtId=occ.debtId||b.debtId||null;if(debtId&&!debtPaymentDateValid(debtId,o.date)){let d=db.debts.find(x=>String(x.id)===String(debtId));return alert(`This payment cannot be dated before ${dateText(debtStartDate(d))}.`)}let tx={id:uid(),date:o.date,type:'bill',description:b.name,amount:amt,category:o.category||b.category||'Other',account:o.account||'',note:o.note||'',billOccurrenceId:occ.id,debtId};db.transactions.push(tx);occ.payments=occ.payments||[];occ.payments.push(tx.id);occ.transactionId=occ.payments[0];occ.paidDate=o.date;occ.actualAmount=occurrencePaidAmount(occ);occ.status=occurrenceDisplayStatus(occ);recalculateDebtLedgers();save();closeModal();render();showBillOccurrence(occ.id);return}
 if(t==='bill'||t==='billEdit'){let id=e.target.dataset.editId||uid();let old=getBill(id),bill={id,name:String(o.name||'').trim(),category:o.category,billType:o.billType,amountType:o.amountType,expectedAmount:+o.expectedAmount,frequency:o.billType==='one-time'?'monthly':o.frequency,startDate:o.startDate,autopay:o.autopay==='yes',debtId:o.debtId||null,notes:o.notes||'',active:t==='billEdit'?o.active==='active':true,createdAt:old?.createdAt||iso(today)};if(!bill.name||!bill.startDate||!Number.isFinite(bill.expectedAmount)||bill.expectedAmount<0){alert('Complete the required bill fields.');return}if(bill.debtId&&!debtPaymentDateValid(bill.debtId,bill.startDate)){let d=db.debts.find(x=>String(x.id)===String(bill.debtId));return alert(`This bill cannot be linked to ${d?.name||'that debt'} because its first due date is before the debt start date (${dateText(debtStartDate(d))}).`)}if(t==='bill'){db.bills.push(bill)}else{if(!old)return alert('That bill no longer exists.');reconcileEditedBill(old,bill);if(old.active===false&&!old.deactivatedAt){/* Legacy inactive bills without a recorded cutoff remain untouched; their historical boundary cannot be inferred. */}}ensureBillOccurrences();recalculateDebtLedgers();save();closeModal();render();return}
if(t==='occurrenceEdit'){let occ=getPaycheckOccurrence(e.target.dataset.occurrenceId);if(!occ)return;let date=o.scheduledDate,amount=+o.expectedAmount;if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(amount)||amount<=0)return alert('Enter a valid scheduled date and positive amount.');if(occ.transactionId&&date!==occ.scheduledDate){return alert('Deposited occurrences keep their scheduled date. Edit the actual deposit instead.')}occ.scheduledDate=date;occ.expectedAmount=amount;occ.overridden=true;occ.status=occ.transactionId?'deposited':date>localDateKey(today)?'scheduled':(date===localDateKey(today)?'awaiting':'historical');save();closeModal();render();return}
 if(t==='deposit'){let occ=getPaycheckOccurrence(e.target.dataset.occurrenceId),amt=+o.actualAmount;if(!occ||!getPaycheckSchedule(occ.paycheckId)||!/^\d{4}-\d{2}-\d{2}$/.test(o.actualDate)||!Number.isFinite(amt)||amt<=0)return alert('Enter a valid actual deposit date and positive amount.');if(occ.transactionId){let old=db.transactions.find(x=>x.id===occ.transactionId);if(old){old.date=o.actualDate;old.amount=amt;old.account=o.account||'';old.note=o.note||'';old.description=getPaycheckSchedule(occ.paycheckId).name;syncPaycheckOccurrenceFromTransaction(old)}}else{let p=getPaycheckSchedule(occ.paycheckId),tx={id:uid(),date:o.actualDate,type:'income',description:p.name,amount:amt,category:'',account:o.account||'',note:o.note||'',paycheckOccurrenceId:occ.id};db.transactions.push(tx);occ.transactionId=tx.id;occ.actualDate=tx.date;occ.actualAmount=tx.amount;occ.status='deposited'}save();closeModal();render();return}
 if(t==='paycheck'||t==='paycheckEdit'){let id=e.target.dataset.editId||uid(),old=getPaycheckSchedule(id),freq=normalizePaycheckFrequency(o.frequency),first=String(o.firstDate||'');let amount=+o.expectedAmount;if(!o.name?.trim()||!/^\d{4}-\d{2}-\d{2}$/.test(first)||!Number.isFinite(amount)||amount<=0)return alert('Complete the paycheck schedule with a name, date, and positive amount.');let p=old||{id,createdAt:iso(today)};p.name=o.name.trim();p.expectedAmount=amount;p.frequency=freq;p.firstDate=first;p.active=t==='paycheck'?true:o.active==='active';if(freq==='semimonthly'){p.firstDay=parseDateParts(first)?.getDate()||1;p.secondDay=Math.min(31,Math.max(2,+o.secondDay||15));}else{delete p.firstDay;delete p.secondDay}if(freq==='custom'){p.customDates=String(o.customDates||'').split(',').map(x=>x.trim()).filter(Boolean).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x));if(!p.customDates.length)p.customDates=[first]}else delete p.customDates;if(!old)db.paychecks.push(p);generatePaycheckOccurrences();save();closeModal();render();return}
 if(t==='assignment'||t==='assignmentEdit'){let editing=t==='assignmentEdit',existing=editing?db.assignments.find(a=>a.id===e.target.dataset.editId):null,occ=getPaycheckOccurrence(o.paycheckOccurrenceId),amt=+o.amount,atype=o.type||'other',targetId=String(o.targetId||'');if(!occ||!Number.isFinite(amt)||amt<=0)return alert('Choose a paycheck occurrence and enter a positive amount.');let current=db.assignments.filter(a=>a.paycheckOccurrenceId===occ.id&&(!editing||a.id!==existing?.id)).reduce((s,a)=>s+(+a.amount||0),0),available=paycheckOccurrenceAmount(occ)-current;if(amt>available+0.005)return alert(`This allocation exceeds the ${money(paycheckOccurrenceAmount(occ))} paycheck by ${money(amt-available)}. Reduce the amount or create another allocation.`);if(atype!=='other'&&!targetId)return alert('Choose a target for this allocation.');let targetLabel='';if(atype==='bill'){let bo=getOccurrence(targetId),b=bo&&getBill(bo.billId);if(!bo||!b){if(!(editing&&existing?.targetId===targetId))return alert('Choose a valid bill occurrence.');targetLabel=existing.label||'Bill'}else targetLabel=`${b.name} — ${dateText(bo.dueDate)}`}else if(atype==='category'){if(!db.categories.includes(targetId))return alert('Choose a valid category.');targetLabel=targetId}else if(atype==='debt'){let d=db.debts.find(x=>x.id===targetId);if(!d){if(!(editing&&existing?.targetId===targetId))return alert('Choose a valid debt.');targetLabel=existing.label||'Debt'}else targetLabel=d.name}else if(atype==='savings'){let g=db.goals.find(x=>x.id===targetId);if(!g){if(!(editing&&existing?.targetId===targetId))return alert('Choose a valid savings goal.');targetLabel=existing.label||'Savings'}else targetLabel=g.name}else if(atype==='investment'){if(!(editing&&existing?.targetId===targetId))return alert('Investment account allocations are no longer available. Choose another allocation type.');targetLabel=existing.label||'Investment allocation'}let label=targetLabel||String(o.label||'').trim()||'Other';if(editing){if(!existing)return alert('That allocation no longer exists.');let oldOcc=getPaycheckOccurrence(existing.paycheckOccurrenceId);existing.paycheckOccurrenceId=occ.id;existing.type=atype;existing.targetId=targetId;existing.label=label;existing.amount=amt;existing.note=o.note||'';oldOcc?.allocationIds&&(oldOcc.allocationIds=oldOcc.allocationIds.filter(id=>id!==existing.id));occ.allocationIds=Array.isArray(occ.allocationIds)?occ.allocationIds:[];if(!occ.allocationIds.includes(existing.id))occ.allocationIds.push(existing.id)}else{let a={id:uid(),paycheckOccurrenceId:occ.id,type:atype,targetId:targetId,label,amount:amt,note:o.note||''};db.assignments.push(a);occ.allocationIds=Array.isArray(occ.allocationIds)?occ.allocationIds:[];occ.allocationIds.push(a.id)}}if(t==='budget'||t==='budgetEdit'){
  const editId=e.target.dataset.editId||'',existing=editId?db.budgets.find(x=>x.id===editId):null,category=String(o.category||'').trim(),amount=+o.amount,effectiveMonth=String(o.effectiveMonth||'');
  if(!category||!db.categories.includes(category)||!/^\d{4}-\d{2}$/.test(effectiveMonth)||effectiveMonth<currentMonth()||!Number.isFinite(amount)||amount<0)return alert('Choose a valid category, current/future effective month, and non-negative budget amount.');
  const duplicate=db.budgets.find(x=>x.category===category&&x.effectiveMonth===effectiveMonth&&x.id!==editId);
  if(duplicate)return alert(`${category} already has a budget change effective ${budgetMonthLabel(effectiveMonth)}. Edit that budget instead.`);
  if(existing){
    if(String(existing.effectiveMonth)===currentMonth()&&effectiveMonth>currentMonth()){
      db.budgets.push({id:'budget-'+uid(),category,amount,effectiveMonth,createdAt:iso(today),updatedAt:iso(today)});
    }else{
      existing.category=category;existing.amount=amount;existing.effectiveMonth=effectiveMonth;existing.updatedAt=iso(today);
    }
  }else db.budgets.push({id:'budget-'+uid(),category,amount,effectiveMonth,createdAt:iso(today),updatedAt:iso(today)});
  save();closeModal();budgetViewMonth=effectiveMonth;render();return;
}if(t==='debt'||t==='debtEdit'){let editing=t==='debtEdit',id=e.target.dataset.editId||uid(),d=editing?db.debts.find(x=>String(x.id)===String(id)):null;let name=String(o.name||'').trim(),apr=+o.apr,minimum=+o.minimum,extra=+o.extra||0,startDate=String(o.startDate||'');if(!name||!['Credit Card','Auto Loan','Personal Loan','Student Loan','Mortgage','Medical','Other'].includes(o.type)||!Number.isFinite(apr)||apr<0||!Number.isFinite(minimum)||minimum<0||!Number.isFinite(extra)||extra<0||!/^\d{4}-\d{2}-\d{2}$/.test(startDate))return alert('Complete the debt fields with valid values.');if(startDate>localDateKey(today))return alert('Debt start date cannot be in the future.');if(editing){if(!d)return alert('That debt account no longer exists.');d.name=name;d.type=o.type;d.minimum=minimum;d.extra=extra;d.startDate=d.startDate||startDate;d.aprHistory=Array.isArray(d.aprHistory)?d.aprHistory:[];let effectiveDate=localDateKey(today);if(apr!==debtAprAt(d,effectiveDate)){d.aprHistory=d.aprHistory.filter(h=>String(h.date)!==effectiveDate);d.aprHistory.push({date:effectiveDate,apr});d.aprHistory.sort((a,b)=>String(a.date).localeCompare(String(b.date)));}d.apr=apr;d.updatedAt=iso(today);recalculateDebtLedgers();d.balance=debtCurrentBalance(d);}else{let balance=+o.balance;if(!Number.isFinite(balance)||balance<0)return alert('Enter a valid non-negative starting balance.');let created=iso(today);d={id, name,type:o.type,startingBalance:balance,currentBalance:balance,balance,apr,minimum,extra,startDate, status:balance<=0?'paid-off':'active',createdAt:created,updatedAt:created,aprHistory:[{date:startDate,apr}]};db.debts.push(d);recalculateDebtLedgers()}}if(t==='goal'||t==='goalEdit'){let editing=t==='goalEdit',g=editing?db.goals.find(x=>x.id===e.target.dataset.editId):null,target=+o.target,start=editing&&g&&o.startingBalance==null?+g.startingBalance:+o.startingBalance,selectedIds=Array.isArray(o.startingTransactionIds)?o.startingTransactionIds:[];if(!o.name?.trim()||!Number.isFinite(target)||target<0||!Number.isFinite(start)||start<0)return alert('Enter a goal name and valid non-negative amounts.');if(editing){if(!g)return alert('That goal no longer exists.');g.name=o.name.trim();g.target=target;g.targetDate=o.targetDate||'';g.status=o.status==='archived'?'archived':'active';g.isEmergencyFund=o.isEmergencyFund==='true';if(start!==+g.startingBalance&&goalTransactions(g.id).length===0&&!(g.startingTransactions||[]).length){g.startingBalance=start;g.history=[{date:g.createdAt||iso(today),value:goalBalance(g.id)}]}}else{let eligibleById=new Map(eligibleGoalStartingTransactions().map(tx=>[String(tx.id),tx]));if(selectedIds.some(id=>!eligibleById.has(String(id))))return alert('One or more selected Savings transactions are no longer available as starting-balance sources. Reopen the goal and select them again.');let startingTransactions=selectedIds.map(id=>{let tx=eligibleById.get(String(id));return{transactionId:String(tx.id),date:String(tx.date),description:transactionDescription(tx),amount:+tx.amount}});let id=uid(),created=iso(today);g={id,name:o.name.trim(),target,targetDate:o.targetDate||'',startingBalance:start,startingTransactions,status:'active',isEmergencyFund:o.isEmergencyFund==='true',createdAt:created,history:[{date:created,value:start+startingTransactions.reduce((sum,x)=>sum+x.amount,0)}]};db.goals.push(g)}if(g.isEmergencyFund)db.goals.forEach(other=>{if(other.id!==g.id)other.isEmergencyFund=false});g.saved=goalBalance(g.id);save();closeModal();render();return}
 if(t==='goalTransaction'){let goalId=e.target.dataset.goalId,g=db.goals.find(x=>x.id===goalId),amount=+o.amount,dir=+e.target.dataset.direction||1;if(!g||!o.date||o.date<g.createdAt||o.date>localDateKey(today)||!o.description?.trim()||!Number.isFinite(amount)||amount<=0)return alert('Enter a valid date from the goal creation date through today, plus a description and positive amount. Future Savings transactions are not allowed.');let signed=amount*dir;if(dir<0&&goalBalance(g.id)+signed<-.005)return alert('This withdrawal would make the goal balance negative.');db.transactions.push({id:uid(),date:o.date,type:'savings',description:o.description.trim(),amount:signed,category:'Savings',account:'',note:o.note||'',goalId:g.id});g.saved=goalBalance(g.id);save();closeModal();render();return}save();closeModal();render()};
$('saveSettings').onclick=()=>{let startDate=$('startCashDate').value||'';if(startDate&&!/^\d{4}-\d{2}-\d{2}$/.test(startDate))return alert('Enter a valid starting cash date.');if(startDate>localDateKey(today))return alert('Starting cash date cannot be in the future. Choose today or an earlier date.');db.settings.currency=$('currency').value;db.settings.startingCash=+$('startCash').value||0;db.settings.startingCashDate=startDate;db.settings.saveTarget=+$('saveTarget').value||0;db.settings.incomeGrowth=+$('incomeGrowth').value||0;const saved=save();applyAppearance();render();if(saved)alert('Financial settings saved and verified on this device.');else alert('Your financial settings changed in this session but could not be saved. Check the save status in the header and Settings, then retry.');};
// Backup/restore format v1. Database schema versions are deliberately independent of app versions.
const BACKUP_COLLECTIONS=['incomes','transactions','bills','billOccurrences','paychecks','paycheckOccurrences','assignments','budgets','debts','goals','deletedGoalHistory','assets','liabilities','investments'];
const BACKUP_ID_COLLECTIONS=['transactions','bills','billOccurrences','paychecks','paycheckOccurrences','assignments','budgets','debts','goals','deletedGoalHistory','assets','liabilities','investments'];
const backupMigrations={
  // Legacy v4.12.73 JSON exports already contain the current data shape. This
  // explicit 0 -> 1 migration stamps that shape; it does not create or alter records.
  0: payload=>({...payload,schemaVersion:1})
};
function bytesToBase64(bytes){let binary='';for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);return btoa(binary)}
function base64ToBytes(value){const binary=atob(value);return Uint8Array.from(binary,c=>c.charCodeAt(0))}
function backupSnapshot(source=db){
  const snapshot=JSON.parse(JSON.stringify(source));
  snapshot.schemaVersion=DB_SCHEMA_VERSION;
  snapshot.settings=snapshot.settings||{};
  // Appearance is portable. Obsolete cloud credentials and updater preferences are never exported.
  delete snapshot.settings.sync;
  delete snapshot.settings.updates;
  delete snapshot.restoreSessionId;
  return snapshot;
}
function deriveBackupKey(password,salt,iterations){
  const material=new TextEncoder().encode(password);
  return crypto.subtle.importKey('raw',material,'PBKDF2',false,['deriveKey']).then(key=>crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']));
}
function backupAuthenticatedHeader(envelope){return new TextEncoder().encode(JSON.stringify({format:envelope.format,backupFormatVersion:envelope.backupFormatVersion,databaseSchemaVersion:envelope.databaseSchemaVersion,appVersion:envelope.appVersion,exportedAt:envelope.exportedAt,encryption:{algorithm:envelope.encryption?.algorithm,keyDerivation:envelope.encryption?.keyDerivation,iterations:envelope.encryption?.iterations,salt:envelope.encryption?.salt,iv:envelope.encryption?.iv}}));}
async function encryptBackupPayload(payload,password){
  if(!crypto?.subtle)throw new Error('Secure encryption is unavailable in this browser. Open MyBudget through HTTPS or localhost and try again.');
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveBackupKey(password,salt,BACKUP_ITERATIONS);
  const header={format:'MYBUDGET_ENCRYPTED_BACKUP',backupFormatVersion:BACKUP_FORMAT_VERSION,databaseSchemaVersion:DB_SCHEMA_VERSION,appVersion:APP_VERSION,exportedAt:new Date().toISOString(),encryption:{algorithm:'AES-256-GCM',keyDerivation:'PBKDF2-HMAC-SHA-256',iterations:BACKUP_ITERATIONS,salt:bytesToBase64(salt),iv:bytesToBase64(iv)}};
  const encoded=new TextEncoder().encode(JSON.stringify(payload));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:backupAuthenticatedHeader(header),tagLength:128},key,encoded);
  return {...header,encryptedData:bytesToBase64(new Uint8Array(cipher))};
}
async function decryptBackupEnvelope(envelope,password){
  if(envelope.format!=='MYBUDGET_ENCRYPTED_BACKUP'||envelope.backupFormatVersion!==BACKUP_FORMAT_VERSION)throw new Error('This backup format version is not supported by this MyBudget version.');
  const meta=envelope.encryption||{};
  if(meta.algorithm!=='AES-256-GCM'||meta.keyDerivation!=='PBKDF2-HMAC-SHA-256'||!Number.isInteger(meta.iterations)||meta.iterations<100000||meta.iterations>2000000||typeof meta.salt!=='string'||typeof meta.iv!=='string'||typeof envelope.encryptedData!=='string')throw new Error('The backup encryption metadata is invalid or unsupported.');
  let plain;
  try{const key=await deriveBackupKey(password,base64ToBytes(meta.salt),meta.iterations);plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(meta.iv),additionalData:backupAuthenticatedHeader(envelope),tagLength:128},key,base64ToBytes(envelope.encryptedData));}
  catch(_){throw new Error('The password is incorrect, or the backup or its metadata is damaged or has been tampered with. No data was changed.');}
  try{return JSON.parse(new TextDecoder().decode(plain));}catch(_){throw new Error('The decrypted backup payload is not valid JSON. No data was changed.');}
}
function migrateBackupPayload(payload){
  if(Object.prototype.hasOwnProperty.call(payload,'schemaVersion')&&!Number.isInteger(payload.schemaVersion))throw new Error('The backup database schema version is invalid.');
  let version=Number.isInteger(payload.schemaVersion)?payload.schemaVersion:0;
  if(version>DB_SCHEMA_VERSION)throw new Error(`This backup uses database schema ${version}, but this app supports schema ${DB_SCHEMA_VERSION}. Update MyBudget before restoring it.`);
  while(version<DB_SCHEMA_VERSION){const migration=backupMigrations[version];if(!migration)throw new Error(`No supported migration exists from database schema ${version}.`);payload=migration(payload);version=payload.schemaVersion;}
  return payload;
}
function validateBackupPayload(payload,options={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('The backup payload must be a JSON object.');
  if(payload.schemaVersion!==DB_SCHEMA_VERSION)throw new Error(`Backup validation failed: expected database schema ${DB_SCHEMA_VERSION}, received ${payload.schemaVersion??'missing'}.`);
  if(!payload.settings||typeof payload.settings!=='object'||Array.isArray(payload.settings))throw new Error('Backup validation failed: settings are missing or invalid.');
  for(const field of ['currency','startingCash','startingCashDate','saveTarget','incomeGrowth'])if(!Object.prototype.hasOwnProperty.call(payload.settings,field))throw new Error(`Backup validation failed: required setting ${field} is missing.`);
  if(typeof payload.settings.startingCashDate!=='string')throw new Error('Backup validation failed: starting cash date is invalid.');
  // Older v4.12.76 backups may contain updater preferences; validate them if present, then ignore them on restore.
  if(Object.prototype.hasOwnProperty.call(payload.settings,'updates')&&(!payload.settings.updates||typeof payload.settings.updates!=='object'||Array.isArray(payload.settings.updates)))throw new Error('Backup validation failed: legacy update settings are invalid.');
  const validDateKey=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const validMonth=value=>typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  const finiteField=(record,field,label)=>{if(record[field]!=null&&(typeof record[field]==='boolean'||String(record[field]).trim()===''||!Number.isFinite(Number(record[field]))))throw new Error(`Backup validation failed: ${label} has an invalid ${field} value.`);};
  const requiredText=(record,field,label)=>{if(typeof record[field]!=='string'||!record[field].trim())throw new Error(`Backup validation failed: ${label} is missing ${field}.`);};
  if(payload.settings.startingCashDate&&!validDateKey(payload.settings.startingCashDate))throw new Error('Backup validation failed: starting cash date is invalid.');
  if(!Array.isArray(payload.categories)||payload.categories.some(x=>typeof x!=='string'||!x.trim()))throw new Error('Backup validation failed: categories are missing or invalid.');
  if(new Set(payload.categories).size!==payload.categories.length)throw new Error('Backup validation failed: category names must be unique.');
  for(const field of ['startingCash','saveTarget','incomeGrowth'])finiteField(payload.settings,field,'settings');
  if(typeof payload.settings.currency!=='string'||! /^[A-Z]{3}$/.test(payload.settings.currency))throw new Error('Backup validation failed: currency setting is invalid.');
  if(payload.settings.updates&&(typeof payload.settings.updates.auto!=='boolean'||typeof payload.settings.updates.lastChecked!=='string'||(payload.settings.updates.lastChecked&&!Number.isFinite(Date.parse(payload.settings.updates.lastChecked)))))throw new Error('Backup validation failed: legacy update settings are incomplete or invalid.');

  // Schema 1 encrypted backups must carry the complete portable appearance object.
  // Legacy unencrypted schema-0 exports may omit it and retain destination appearance.
  const appearance=payload.settings.appearance;
  if(!appearance){if(!options.allowMissingAppearance)throw new Error('Backup validation failed: appearance preferences are missing. This backup cannot safely restore the saved appearance.');}
  else{
    if(typeof appearance!=='object'||Array.isArray(appearance))throw new Error('Backup validation failed: appearance preferences are invalid.');
    const appearanceEnums={theme:[...Object.keys(THEMES),...Object.keys(THEME_MIGRATIONS)],iconPreset:['outline','rounded','bold','minimal'],cardStyle:['clean-elevated','modern-colorful','elegant-dark','soft-pastel','gradient-accent','minimal-modern'],iconShape:['standard','rounded','circle'],iconWeight:['light','regular','bold'],iconSize:['small','medium','large'],density:['compact','comfortable','spacious']};
    for(const [field,allowed] of Object.entries(appearanceEnums))if(typeof appearance[field]!=='string'||!allowed.includes(appearance[field]))throw new Error(`Backup validation failed: appearance setting “${field}” is missing or unsupported (${String(appearance[field])}). Update MyBudget or use a compatible backup; the saved appearance will not be silently reset.`);
    if(!appearance.icons||typeof appearance.icons!=='object'||Array.isArray(appearance.icons))throw new Error('Backup validation failed: appearance icon customizations are missing or invalid.');
    const iconTargets=['dashboard','transactions','plan','bills','reports','annual','budgets','debts','goals','data'];
    for(const [slot,value] of Object.entries(appearance.icons))if(!iconTargets.includes(slot)||typeof value!=='string'||!Object.prototype.hasOwnProperty.call(ICON_LIBRARY,value))throw new Error(`Backup validation failed: appearance icon customization “${slot}” is unsupported.`);
    if(typeof appearance.customAccent!=='string')throw new Error('Backup validation failed: custom appearance accent is invalid.');
  }

  for(const name of BACKUP_COLLECTIONS){if(!Array.isArray(payload[name]))throw new Error(`Backup validation failed: the ${name} collection is missing or invalid. No data was changed.`);if(payload[name].some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw new Error(`Backup validation failed: ${name} contains a non-record value.`);}
  for(const name of BACKUP_ID_COLLECTIONS){const seen=new Set();for(const item of payload[name]){if(item.id==null||String(item.id).trim()==='')throw new Error(`Backup validation failed: a ${name} record has no ID.`);const id=String(item.id);if(seen.has(id))throw new Error(`Backup validation failed: duplicate ID ${id} in ${name}.`);seen.add(id);}}
  const numericFields={incomes:['amount'],transactions:['amount'],bills:['amount','expectedAmount'],billOccurrences:['expectedAmount','actualAmount'],paychecks:['expectedAmount'],paycheckOccurrences:['expectedAmount','actualAmount'],assignments:['amount'],budgets:['amount'],debts:['balance','currentBalance','startingBalance','apr','minimum','extra'],goals:['target','startingBalance','saved'],assets:['value','balance','amount'],liabilities:['value','balance','amount'],investments:['value','balance','amount','contribution']};
  for(const [collection,fields] of Object.entries(numericFields))for(const item of payload[collection])for(const field of fields)finiteField(item,field,`${collection} record ${item.id??'(legacy)'}`);
  for(const item of payload.transactions){finiteField(item,'amount',`transaction ${item.id}`);if(item.amount==null)throw new Error(`Backup validation failed: transaction ${item.id} is missing amount.`);if(!validDateKey(item.date))throw new Error(`Backup validation failed: transaction ${item.id} has an invalid date.`);if(!['expense','bill','income','savings','investment'].includes(item.type))throw new Error(`Backup validation failed: transaction ${item.id} has an unsupported type.`);}
  for(const item of payload.bills){requiredText(item,'name',`bill ${item.id}`);finiteField(item,'expectedAmount',`bill ${item.id}`);if(item.expectedAmount==null)throw new Error(`Backup validation failed: bill ${item.id} is missing expectedAmount.`);if(!validDateKey(item.startDate))throw new Error(`Backup validation failed: bill ${item.id} has an invalid start date.`);if(item.frequency!=null&&!['weekly','biweekly','monthly','quarterly','semiannual','annual','one-time'].includes(item.frequency))throw new Error(`Backup validation failed: bill ${item.id} has an unsupported frequency.`);if(item.billType!=null&&!['recurring','one-time'].includes(item.billType))throw new Error(`Backup validation failed: bill ${item.id} has an unsupported bill type.`);if(item.amountType!=null&&!['fixed','variable'].includes(item.amountType))throw new Error(`Backup validation failed: bill ${item.id} has an unsupported amount type.`);if(item.active!=null&&typeof item.active!=='boolean')throw new Error(`Backup validation failed: bill ${item.id} has an invalid active flag.`);}
  for(const item of payload.billOccurrences){finiteField(item,'expectedAmount',`bill occurrence ${item.id}`);if(item.expectedAmount==null)throw new Error(`Backup validation failed: bill occurrence ${item.id} is missing expectedAmount.`);if(!validDateKey(item.dueDate))throw new Error(`Backup validation failed: bill occurrence ${item.id} has an invalid due date.`);if(item.payments!=null&&!Array.isArray(item.payments))throw new Error(`Backup validation failed: bill occurrence ${item.id} has invalid payment links.`);if(item.superseded!=null&&typeof item.superseded!=='boolean')throw new Error(`Backup validation failed: bill occurrence ${item.id} has an invalid superseded flag.`);}
  const paycheckFrequencies=['one-time','weekly','biweekly','monthly','quarterly','semimonthly','semi-monthly','custom'];
  for(const item of payload.paychecks){requiredText(item,'name',`paycheck ${item.id}`);finiteField(item,'expectedAmount',`paycheck ${item.id}`);if(item.expectedAmount==null)throw new Error(`Backup validation failed: paycheck ${item.id} is missing expectedAmount.`);if(!validDateKey(item.firstDate))throw new Error(`Backup validation failed: paycheck ${item.id} has an invalid first date.`);if(item.frequency!=null&&!paycheckFrequencies.includes(item.frequency))throw new Error(`Backup validation failed: paycheck ${item.id} has an unsupported frequency.`);if(item.active!=null&&typeof item.active!=='boolean')throw new Error(`Backup validation failed: paycheck ${item.id} has an invalid active flag.`);if(item.customDates!=null&&(!Array.isArray(item.customDates)||item.customDates.some(d=>!validDateKey(d))))throw new Error(`Backup validation failed: paycheck ${item.id} has invalid custom dates.`);}
  for(const item of payload.paycheckOccurrences){finiteField(item,'expectedAmount',`paycheck occurrence ${item.id}`);if(item.expectedAmount==null)throw new Error(`Backup validation failed: paycheck occurrence ${item.id} is missing expectedAmount.`);if(!validDateKey(item.scheduledDate))throw new Error(`Backup validation failed: paycheck occurrence ${item.id} has an invalid scheduled date.`);if(item.allocationIds!=null&&!Array.isArray(item.allocationIds))throw new Error(`Backup validation failed: paycheck occurrence ${item.id} has invalid allocation links.`);}
  for(const item of payload.assignments){finiteField(item,'amount',`assignment ${item.id}`);if(item.amount==null)throw new Error(`Backup validation failed: assignment ${item.id} is missing amount.`);if(item.type!=null&&!['bill','debt','savings','category','investment','other'].includes(item.type))throw new Error(`Backup validation failed: assignment ${item.id} has an unsupported type.`);}
  for(const item of payload.budgets){finiteField(item,'amount',`budget ${item.id}`);if(item.amount==null)throw new Error(`Backup validation failed: budget ${item.id} is missing amount.`);if(!validMonth(item.effectiveMonth))throw new Error(`Backup validation failed: budget ${item.id} has an invalid effective month.`);requiredText(item,'category',`budget ${item.id}`);}
  for(const item of payload.debts){requiredText(item,'name',`debt ${item.id}`);if(item.type!=null&&!['Credit Card','Auto Loan','Personal Loan','Student Loan','Mortgage','Medical','Other'].includes(item.type))throw new Error(`Backup validation failed: debt ${item.id} has an unsupported type.`);for(const field of ['startingBalance','currentBalance','apr','minimum','extra'])if(item[field]==null)throw new Error(`Backup validation failed: debt ${item.id} is missing ${field}.`);if(item.aprHistory!=null&&!Array.isArray(item.aprHistory))throw new Error(`Backup validation failed: debt ${item.id} has invalid APR history.`);if(item.status!=null&&!['active','paid-off','archived'].includes(item.status))throw new Error(`Backup validation failed: debt ${item.id} has an unsupported status.`);if(item.aprHistory)for(const entry of item.aprHistory)if(!entry||typeof entry!=='object'||!validDateKey(entry.date)||entry.apr==null||!Number.isFinite(Number(entry.apr)))throw new Error(`Backup validation failed: debt ${item.id} has an invalid APR history entry.`);}
  for(const item of payload.goals){requiredText(item,'name',`goal ${item.id}`);for(const field of ['target','startingBalance'])if(item[field]==null)throw new Error(`Backup validation failed: goal ${item.id} is missing ${field}.`);if(item.targetDate&&!validDateKey(item.targetDate))throw new Error(`Backup validation failed: goal ${item.id} has an invalid target date.`);if(item.status!=null&&!['active','archived','completed'].includes(item.status))throw new Error(`Backup validation failed: goal ${item.id} has an unsupported status.`);if(item.history!=null&&(!Array.isArray(item.history)||item.history.some(h=>!h||typeof h!=='object'||typeof h.date!=='string'||(!validDateKey(h.date)&&!Number.isFinite(Date.parse(h.date)))||h.value==null||!Number.isFinite(Number(h.value)))))throw new Error(`Backup validation failed: goal ${item.id} has invalid balance history.`);if(item.startingTransactions!=null&&(!Array.isArray(item.startingTransactions)||item.startingTransactions.some(x=>!x||typeof x!=='object'||x.transactionId==null||!validDateKey(x.date)||!Number.isFinite(Number(x.amount)))))throw new Error(`Backup validation failed: goal ${item.id} has invalid starting-transaction history.`);}

  for(const item of payload.deletedGoalHistory){if(item.startingTransactions!=null&&(!Array.isArray(item.startingTransactions)||item.startingTransactions.some(x=>!x||typeof x!=='object'||x.transactionId==null||!validDateKey(x.date)||!Number.isFinite(Number(x.amount)))))throw new Error(`Backup validation failed: deleted goal ${item.id} has invalid starting-transaction history.`);}
  const ids=name=>new Set(payload[name].map(x=>String(x.id)));
  const txIds=ids('transactions'),billIds=ids('bills'),billOccIds=ids('billOccurrences'),paycheckIds=ids('paychecks'),paycheckOccIds=ids('paycheckOccurrences'),debtIds=ids('debts'),goalIds=ids('goals'),deletedGoalIds=ids('deletedGoalHistory'),assignmentIds=ids('assignments');
  const warnings=[];
  const warnRef=(value,set,label)=>{if(value!=null&&value!==''&&!set.has(String(value)))warnings.push(`${label} references missing record ${value}; the historical reference will be preserved.`)};
  const warnMismatch=(condition,message)=>{if(condition)warnings.push(`${message}; the original records will be preserved.`)};
  for(const tx of payload.transactions){warnRef(tx.billOccurrenceId,billOccIds,'Transaction bill occurrence');warnRef(tx.paycheckOccurrenceId,paycheckOccIds,'Transaction paycheck occurrence');warnRef(tx.debtId,debtIds,'Transaction debt');warnRef(tx.investmentId,ids('investments'),'Transaction investment');if(tx.category&& !payload.categories.includes(tx.category))warnMismatch(true,`Transaction ${tx.id} uses category ${tx.category}, which is not in the category list`);if(tx.goalId!=null&&!goalIds.has(String(tx.goalId))&&!deletedGoalIds.has(String(tx.goalId)))warnings.push(`Transaction savings goal ${tx.goalId} is not present in active or deleted-goal history; the reference will be preserved.`);if(tx.billOccurrenceId!=null){const occ=payload.billOccurrences.find(o=>String(o.id)===String(tx.billOccurrenceId));if(occ&&Array.isArray(occ.payments)&&!occ.payments.some(id=>String(id)===String(tx.id))&&String(occ.transactionId||'')!==String(tx.id))warnMismatch(true,`Transaction ${tx.id} links to bill occurrence ${occ.id}, but the occurrence does not list the transaction as a payment`);}}
  for(const o of payload.billOccurrences){warnRef(o.billId,billIds,'Bill occurrence');if(Array.isArray(o.payments))o.payments.forEach(id=>{warnRef(id,txIds,'Bill payment');const tx=payload.transactions.find(t=>String(t.id)===String(id));if(tx&&String(tx.billOccurrenceId||'')!==String(o.id))warnMismatch(true,`Bill occurrence ${o.id} lists transaction ${id}, but that transaction links elsewhere`)});warnRef(o.transactionId,txIds,'Bill transaction');warnRef(o.debtId,debtIds,'Bill occurrence debt');if(o.transactionId){const tx=payload.transactions.find(t=>String(t.id)===String(o.transactionId));if(tx&&tx.billOccurrenceId!=null&&String(tx.billOccurrenceId)!==String(o.id))warnMismatch(true,`Bill occurrence ${o.id} points to transaction ${o.transactionId}, but that transaction links elsewhere`);}}
  for(const o of payload.paycheckOccurrences){warnRef(o.paycheckId,paycheckIds,'Paycheck occurrence');warnRef(o.transactionId,txIds,'Paycheck transaction');if(o.transactionId){const tx=payload.transactions.find(t=>String(t.id)===String(o.transactionId));if(tx&&tx.paycheckOccurrenceId!=null&&String(tx.paycheckOccurrenceId)!==String(o.id))warnMismatch(true,`Paycheck occurrence ${o.id} points to transaction ${o.transactionId}, but that transaction links elsewhere`);}if(Array.isArray(o.allocationIds))o.allocationIds.forEach(id=>{warnRef(id,assignmentIds,'Paycheck allocation');const a=payload.assignments.find(x=>String(x.id)===String(id));if(a&&String(a.paycheckOccurrenceId)!==String(o.id))warnMismatch(true,`Paycheck occurrence ${o.id} lists allocation ${id}, but that allocation links elsewhere`)});}
  for(const a of payload.assignments){warnRef(a.paycheckOccurrenceId,paycheckOccIds,'Paycheck assignment');if(a.type==='investment')warnRef(a.targetId,ids('investments'),'Investment allocation');if(a.type==='bill')warnRef(a.targetId,billOccIds,'Bill allocation');if(a.type==='debt')warnRef(a.targetId,debtIds,'Debt allocation');if(a.type==='savings'&&!goalIds.has(String(a.targetId))&&!deletedGoalIds.has(String(a.targetId)))warnings.push(`Savings allocation target ${a.targetId} is missing; the historical reference will be preserved.`);const occ=payload.paycheckOccurrences.find(o=>String(o.id)===String(a.paycheckOccurrenceId));if(occ&&Array.isArray(occ.allocationIds)&&!occ.allocationIds.some(id=>String(id)===String(a.id)))warnMismatch(true,`Paycheck assignment ${a.id} is not listed by its linked occurrence ${occ.id}`);}
  for(const b of payload.bills){warnRef(b.debtId,debtIds,'Bill debt');if(b.category&&!payload.categories.includes(b.category))warnMismatch(true,`Bill ${b.id} uses category ${b.category}, which is not in the category list`);}
  for(const g of payload.goals)for(const source of g.startingTransactions||[])warnRef(source.transactionId,txIds,'Savings goal starting transaction');
  if(payload.dashboardSnapshotGoalIds!=null&&!Array.isArray(payload.dashboardSnapshotGoalIds))throw new Error('Backup validation failed: Dashboard savings-goal selections are invalid.');
  if(Array.isArray(payload.dashboardSnapshotGoalIds))payload.dashboardSnapshotGoalIds.forEach(id=>warnRef(id,goalIds,'Dashboard savings-goal selection'));
  return [...new Set(warnings)];
}
function openRecoveryDB(){return new Promise((resolve,reject)=>{const request=indexedDB.open(RESTORE_RECOVERY_DB,1);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('recovery'))request.result.createObjectStore('recovery',{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('Could not open secure local recovery storage.'));});}
async function putRecoveryBackup(record){const database=await openRecoveryDB();await new Promise((resolve,reject)=>{const tx=database.transaction('recovery','readwrite');tx.objectStore('recovery').put(record);tx.oncomplete=resolve;tx.onerror=()=>reject(new Error('Could not save the pre-restore recovery backup.'));tx.onabort=()=>reject(new Error('Could not save the pre-restore recovery backup.'));});database.close();}
async function getRecoveryBackup(id){const database=await openRecoveryDB();const value=await new Promise((resolve,reject)=>{const tx=database.transaction('recovery','readonly'),request=tx.objectStore('recovery').get(id);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(new Error('Could not read the recovery backup.'));});database.close();return value;}
async function deleteRecoveryBackup(id){const database=await openRecoveryDB();await new Promise((resolve,reject)=>{const tx=database.transaction('recovery','readwrite');tx.objectStore('recovery').delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(new Error('Could not remove the recovery backup.'));});database.close();}
function downloadJsonFile(object,filename){const url=URL.createObjectURL(new Blob([JSON.stringify(object,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function passwordPrompt(label){const value=prompt(label);if(value===null)return null;if(value.length<12){alert('Use a password with at least 12 characters.');return null;}return value;}
async function exportEncryptedBackup(){try{const snapshot=backupSnapshot();const warnings=validateBackupPayload(snapshot);if(warnings.length&&!confirm(`The backup contains ${warnings.length} historical relationship warning(s). They will be preserved exactly. Continue with export?\n\n${warnings.slice(0,8).join('\n')}${warnings.length>8?'\n…':''}`))return;const password=passwordPrompt('Create a password for this encrypted MyBudget backup (at least 12 characters). Keep it safe; MyBudget cannot recover it.');if(password===null)return;const confirmPassword=prompt('Re-enter the backup password to confirm.');if(confirmPassword===null)return;if(password!==confirmPassword)return alert('The passwords do not match. No backup was created.');const envelope=await encryptBackupPayload(snapshot,password);downloadJsonFile(envelope,`mybudget-encrypted-backup-${iso(today)}.json`);alert('Encrypted backup created. Your password was not saved.');}catch(error){alert(`Backup could not be created: ${error.message||error}`);}}
function showRestoreRecoveryControls(){
  let panel=$('restoreRecoveryPanel');if(!panel){panel=document.createElement('div');panel.id='restoreRecoveryPanel';panel.className='notice section';document.body.appendChild(panel);}
  if(!restoreVerificationMode){panel.hidden=true;return;}
  let marker;try{marker=JSON.parse(localStorage.getItem(RESTORE_PENDING_KEY)||'{}')}catch(_){marker={};}
  document.body.classList.add('restore-verification');if(!document.getElementById('restoreVerificationStyle')){const style=document.createElement('style');style.id='restoreVerificationStyle';style.textContent='body.restore-verification .page button,body.restore-verification .page input,body.restore-verification .page select,body.restore-verification .page textarea,body.restore-verification .page a,body.restore-verification .page [onclick]{pointer-events:none!important;opacity:.58}body.restore-verification #restoreRecoveryPanel{pointer-events:auto;opacity:1}body.restore-verification #modalBack{pointer-events:none}';document.head.appendChild(style);}
  document.querySelectorAll('.page').forEach(page=>{page.inert=true;});panel.hidden=false;panel.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:10000;max-width:760px;max-height:45vh;overflow:auto;margin:0 auto;box-shadow:0 8px 32px rgba(0,0,0,.22);';panel.innerHTML='<strong>Restore verification mode</strong><p>MyBudget has opened the restored data without running migrations or generating bill/paycheck occurrences. Review your financial records before finishing.</p><div class="toolbar"><button class="btn" id="downloadRecoveryBtn">Download pre-restore recovery backup</button><button class="btn danger" id="rollbackRestoreBtn">Roll back to pre-restore data</button><button class="btn primary" id="finishRestoreBtn">I verified the restored data</button></div>';
  $('downloadRecoveryBtn').onclick=async()=>{try{const recovery=await getRecoveryBackup(marker.recoveryId);if(!recovery)throw new Error('The recovery backup could not be found.');downloadJsonFile(recovery.envelope,`mybudget-pre-restore-recovery-${marker.createdAt.slice(0,10)}.json`);}catch(error){alert(error.message||error);}};
  $('rollbackRestoreBtn').onclick=async()=>{const password=passwordPrompt('Enter the recovery password you created or used during import to decrypt the pre-restore recovery copy.');if(password===null)return;try{const recovery=await getRecoveryBackup(marker.recoveryId);if(!recovery)throw new Error('The recovery backup could not be found.');const oldDb=await decryptBackupEnvelope(recovery.envelope,password);validateBackupPayload(migrateBackupPayload(oldDb));delete oldDb.settings.sync;delete oldDb.settings.updates;oldDb.schemaVersion=DB_SCHEMA_VERSION;localStorage.setItem(KEY,JSON.stringify(oldDb));await deleteRecoveryBackup(marker.recoveryId);localStorage.removeItem(RESTORE_PENDING_KEY);location.reload();}catch(error){alert(`Rollback failed: ${error.message||error}. Current data was not intentionally changed.`);}};
  $('finishRestoreBtn').onclick=async()=>{if(!confirm('Have you opened MyBudget and checked that your restored financial data is correct? The pre-restore recovery copy will be deleted after you confirm.'))return;try{delete db.restoreSessionId;localStorage.setItem(KEY,JSON.stringify(db));await deleteRecoveryBackup(marker.recoveryId);localStorage.removeItem(RESTORE_PENDING_KEY);alert('Restore verification completed. Normal MyBudget operation has resumed.');location.reload();}catch(error){alert(`Could not finish restore verification: ${error.message||error}. The recovery copy has been retained.`);}};
}
$('exportBtn').onclick=exportEncryptedBackup;
$('importBtn').onclick=()=>$('fileInput').click();
showRestoreRecoveryControls();
$('fileInput').onchange=async e=>{
  const file=e.target.files?.[0];if(!file)return;
  try{
    const parsed=JSON.parse(await file.text());let incoming,isLegacy=false,password;
    if(parsed?.format==='MYBUDGET_ENCRYPTED_BACKUP'){
      password=passwordPrompt('Enter the password for this encrypted MyBudget backup.');if(password===null)return;
      incoming=await decryptBackupEnvelope(parsed,password);
      if(parsed.databaseSchemaVersion!==incoming.schemaVersion)throw new Error('Backup metadata and payload schema versions do not match.');
    }else{
      isLegacy=true;
      if(!confirm('This is an unencrypted legacy JSON backup. It will be validated and imported through the legacy compatibility pathway. Continue?'))return;
      incoming=parsed;
    }
    incoming=migrateBackupPayload(incoming);const hasPortableAppearance=!!(incoming.settings&&incoming.settings.appearance&&typeof incoming.settings.appearance==='object'&&!Array.isArray(incoming.settings.appearance));if(!hasPortableAppearance&&!isLegacy)throw new Error('This encrypted backup is missing its required appearance preferences. It may be incomplete or incompatible; no data was changed.');if(!hasPortableAppearance&&isLegacy&&!confirm('This legacy backup does not contain appearance preferences. Your current device appearance will be preserved because the original appearance cannot be recovered from this file. Continue?'))return;const validationWarnings=validateBackupPayload(incoming,{allowMissingAppearance:isLegacy});if(validationWarnings.length&&!confirm(`The backup passed structural validation but contains ${validationWarnings.length} historical relationship warning(s). These references will be preserved, not discarded. Continue?\n\n${validationWarnings.slice(0,8).join('\n')}${validationWarnings.length>8?'\n…':''}`))return;
    if(isLegacy){password=passwordPrompt('Create a password for the encrypted pre-restore recovery backup (at least 12 characters).');if(password===null)return;const second=prompt('Re-enter the recovery password to confirm.');if(second===null)return;if(password!==second)throw new Error('The recovery passwords do not match. No data was changed.');}
    if(!confirm('This will replace the financial data, financial settings, and appearance preferences on this device with those from the backup, including theme, icon customizations, card style, and display density. A recoverable pre-restore backup will be created first. Continue?'))return;
    const recoverySnapshot=backupSnapshot(db);validateBackupPayload(recoverySnapshot);const recoveryEnvelope=await encryptBackupPayload(recoverySnapshot,password);
    const recoveryId=`recovery-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    await putRecoveryBackup({id:recoveryId,createdAt:new Date().toISOString(),envelope:recoveryEnvelope});
    const nextDb=JSON.parse(JSON.stringify(incoming));
    nextDb.settings={...nextDb.settings,appearance:hasPortableAppearance?nextDb.settings.appearance:db.settings.appearance};
    delete nextDb.settings.sync;delete nextDb.settings.updates;
    nextDb.schemaVersion=DB_SCHEMA_VERSION;
    const sessionId=`restore-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;nextDb.restoreSessionId=sessionId;
    const marker={recoveryId,sessionId,createdAt:new Date().toISOString(),source:isLegacy?'legacy-json':'encrypted-backup'};
    try{localStorage.setItem(RESTORE_PENDING_KEY,JSON.stringify(marker));localStorage.setItem(KEY,JSON.stringify(nextDb));}
    catch(error){localStorage.removeItem(RESTORE_PENDING_KEY);await deleteRecoveryBackup(recoveryId);throw new Error(`The restored database could not be written to local storage: ${error.message||error}`);}
    location.reload();
  }catch(error){alert(`Backup import was rejected: ${error.message||error}. Your existing financial data was not replaced.`);}
  finally{e.target.value='';}
};
$('txSearch')?.addEventListener('input',()=>{if(document.querySelector('.page.active')?.id==='transactions')renderTransactions()});
$('txFilter')?.addEventListener('change',()=>{if(document.querySelector('.page.active')?.id==='transactions')renderTransactions()});
$('csvBtn').onclick=()=>{let rows=[['Date','Description','Type','Category','Account','Amount','Note','Bill','Paycheck','Savings Goal','Debt','Investment'],...db.transactions.map(x=>{let b=x.billOccurrenceId?getBill(getOccurrence(x.billOccurrenceId)?.billId):null,p=x.paycheckOccurrenceId?getPaycheckOccurrence(x.paycheckOccurrenceId):null;return [x.date,transactionDescription(x),transactionTypeLabel(x),x.category,x.account,x.amount,x.note,b?.name||'',getPaycheckSchedule(p?.paycheckId)?.name||'',x.goalId?(db.goals.find(g=>g.id===x.goalId)?.name||deletedGoalLabel(x.goalId)):'',x.debtId?(db.debts.find(d=>String(d.id)===String(x.debtId))?.name||'Historical Debt'):'',x.investmentId?db.investments.find(i=>i.id===x.investmentId)?.name||'':'']})];let csv=rows.map(r=>r.map(x=>`"${String(x??'').replace(/"/g,'""')}"`).join(',')).join('\n'),a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='transactions.csv';a.click()};
$('eraseBtn').onclick=()=>{if(confirm('Erase all data? Export a backup first if you may need it.')){localStorage.removeItem(KEY);localStorage.removeItem(LEGACY_KEY);location.reload()}};

$('annualYear')?.addEventListener('change',()=>renderAnnual());
$('annualThisYear')?.addEventListener('click',()=>{const sel=$('annualYear');if(sel){const y=String(today.getFullYear());if(![...sel.options].some(o=>o.value===y)){const option=document.createElement('option');option.value=y;option.textContent=y;sel.appendChild(option);}sel.value=y;}renderAnnual();});
window.addEventListener('resize',()=>render());
window.addEventListener('beforeunload',event=>{if(saveStatusState==='failed'){event.preventDefault();event.returnValue='';}});
$('retrySaveBtn')?.addEventListener('click',()=>{if(save())alert('All current changes were saved and verified on this device.');});
if(storageStartupError){
  document.body.classList.add('storage-startup-blocked');
  const warning=document.createElement('div');
  warning.className='storageStartupWarning';
  warning.innerHTML='<div class="storageStartupCard"><h2>MyBudget could not safely access local storage</h2><p>MyBudget could not complete its local-storage startup checks. It has not intentionally replaced your saved database with a blank one, and saving is disabled for this session.</p><p id="storageStartupError"></p><p>Do not enter or edit financial information in this session. Check this site’s browser storage permissions, then reload MyBudget. If the problem continues, use a recent encrypted backup only after confirming the original local data is safe.</p><button class="btn primary" id="reloadAfterStorageError">Reload MyBudget</button></div>';
  document.body.appendChild(warning);
  const detail=document.getElementById('storageStartupError');if(detail)detail.textContent=storageStartupError.message||String(storageStartupError);
  document.getElementById('reloadAfterStorageError')?.addEventListener('click',()=>location.reload());
}
updateSaveStatusUI();updateStorageMonitor();applyAppearance();nav('dashboard');

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{navigator.serviceWorker.register('./sw.js').catch(()=>{});});
}