
const $ = s => document.querySelector(s);
const dbKey = 'shuangfa_vendor_payments_v1';
let payments = JSON.parse(localStorage.getItem(dbKey) || '[]');
let signatureData = '';
let invoicePhotos = [];
let checkPhotoData = '';

function money(n){return new Intl.NumberFormat('zh-TW',{style:'currency',currency:'TWD',maximumFractionDigits:0}).format(Number(n||0))}
function saveDB(){localStorage.setItem(dbKey, JSON.stringify(payments));render()}
function todayISO(){return new Date().toISOString().slice(0,10)}

function render(){
  const now = new Date();
  const ym = now.toISOString().slice(0,7);
  $('#monthTotal').textContent = money(payments.filter(p=>p.createdAt.slice(0,7)===ym).reduce((s,p)=>s+p.net,0));
  $('#pendingSign').textContent = payments.filter(p=>!p.signature).length;
  $('#completed').textContent = payments.filter(p=>p.status==='已完成').length;

  const soon = payments.filter(p=>{
    if(!p.dueDate || p.status==='已完成') return false;
    const d=(new Date(p.dueDate+'T23:59:59')-now)/86400000;
    return d>=0 && d<=7;
  });
  $('#dueSoon').textContent = soon.length;
  $('#dueList').className='list'+(soon.length?'':' empty');
  $('#dueList').innerHTML = soon.length ? soon.map(p=>`
    <div class="payment-item">
      <div class="payment-top"><div><h3>${p.vendor}</h3><div class="meta">票號：${p.checkNo||'未填'}<br>到期日：${p.dueDate}</div></div><div class="amount">${money(p.net)}</div></div>
    </div>`).join('') : '目前沒有即將到期的支票';

  const q=$('#searchInput').value.trim().toLowerCase();
  const list=payments.filter(p=>[p.vendor,p.checkNo,p.month,p.collector].join(' ').toLowerCase().includes(q));
  $('#paymentList').className='list'+(list.length?'':' empty');
  $('#paymentList').innerHTML=list.length?list.slice().reverse().map(p=>`
    <div class="payment-item">
      <div class="payment-top">
        <div>
          <h3>${p.vendor}</h3>
          <div class="meta">收款月份：${p.month}<br>票號：${p.checkNo||'—'}｜到期：${p.dueDate||'—'}<br>扣款：${money(p.deductionTotal)}</div>
          <span class="badge ${p.signature?'signed':'pending'}">${p.signature?'已手寫簽收':'待簽收'}</span>
        </div>
        <div class="amount">${money(p.net)}</div>
      </div>
    </div>`).join(''):'尚無資料';
}

function addDeduction(name='',note='',amount=0){
  const node=$('#deductionTemplate').content.cloneNode(true);
  const row=node.querySelector('.deduction-row');
  row.querySelector('.deduction-name').value=name;
  row.querySelector('.deduction-note').value=note;
  row.querySelector('.deduction-amount').value=amount;
  row.querySelectorAll('input').forEach(i=>i.addEventListener('input',calc));
  row.querySelector('.remove-row').onclick=()=>{row.remove();calc()};
  $('#deductionRows').appendChild(node);
}
function calc(){
  const gross=Number($('#grossAmount').value||0);
  const adj=Number($('#adjustmentAmount').value||0);
  const deductions=[...document.querySelectorAll('.deduction-amount')].reduce((s,i)=>s+Number(i.value||0),0);
  $('#grossDisplay').textContent=money(gross);
  $('#deductionDisplay').textContent=money(deductions);
  $('#netDisplay').textContent=money(gross+adj-deductions);
}
function resetForm(){
  $('#paymentForm').reset();
  $('#paymentMonth').value=new Date().toISOString().slice(0,7);
  $('#deductionRows').innerHTML='';
  addDeduction();
  signatureData=''; checkPhotoData=''; invoicePhotos=[];
  $('#checkPreview').src=''; $('#invoicePreview').innerHTML=''; $('#signStatus').textContent='尚未簽名';
  calc();
}

$('#newPaymentBtn').onclick=()=>{resetForm();$('#paymentDialog').showModal()}
$('#closeDialog').onclick=()=>$('#paymentDialog').close()
$('#addDeductionBtn').onclick=()=>addDeduction()
$('#grossAmount').addEventListener('input',calc)
$('#adjustmentAmount').addEventListener('input',calc)
$('#searchInput').addEventListener('input',render)

function fileToData(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file)})}
$('#checkPhoto').onchange=async e=>{if(e.target.files[0]){checkPhotoData=await fileToData(e.target.files[0]);$('#checkPreview').src=checkPhotoData}}
$('#invoicePhoto').onchange=async e=>{invoicePhotos=await Promise.all([...e.target.files].map(fileToData));$('#invoicePreview').innerHTML=invoicePhotos.map(x=>`<img src="${x}">`).join('')}

const screen=$('#signatureScreen'), canvas=$('#signatureCanvas'), ctx=canvas.getContext('2d');
let drawing=false;
function sizeCanvas(){const r=canvas.getBoundingClientRect();const ratio=devicePixelRatio||1;canvas.width=r.width*ratio;canvas.height=r.height*ratio;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.lineWidth=3;ctx.lineCap='round';ctx.strokeStyle='#111'}
function point(e){const r=canvas.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return {x:t.clientX-r.left,y:t.clientY-r.top}}
function start(e){drawing=true;const p=point(e);ctx.beginPath();ctx.moveTo(p.x,p.y);e.preventDefault()}
function move(e){if(!drawing)return;const p=point(e);ctx.lineTo(p.x,p.y);ctx.stroke();e.preventDefault()}
function end(){drawing=false}
['mousedown','touchstart'].forEach(x=>canvas.addEventListener(x,start,{passive:false}))
['mousemove','touchmove'].forEach(x=>canvas.addEventListener(x,move,{passive:false}))
;['mouseup','mouseleave','touchend'].forEach(x=>canvas.addEventListener(x,end))
$('#openSignatureBtn').onclick=()=>{screen.classList.remove('hidden');setTimeout(sizeCanvas,50)}
$('#exitSignature').onclick=()=>screen.classList.add('hidden')
$('#clearSignature').onclick=()=>ctx.clearRect(0,0,canvas.width,canvas.height)
$('#confirmSignature').onclick=()=>{signatureData=canvas.toDataURL('image/png');$('#signStatus').textContent='已完成廠商手寫簽名';screen.classList.add('hidden')}

$('#paymentForm').addEventListener('submit',e=>{
  e.preventDefault();
  const rows=[...document.querySelectorAll('.deduction-row')].map(r=>({
    name:r.querySelector('.deduction-name').value.trim(),
    note:r.querySelector('.deduction-note').value.trim(),
    amount:Number(r.querySelector('.deduction-amount').value||0)
  })).filter(x=>x.name||x.note||x.amount);
  const gross=Number($('#grossAmount').value||0), adj=Number($('#adjustmentAmount').value||0);
  const deductionTotal=rows.reduce((s,x)=>s+x.amount,0), net=gross+adj-deductionTotal;
  if(!signatureData){alert('請先讓廠商在大畫面完成手寫簽名');return}
  payments.push({
    id:crypto.randomUUID(),createdAt:new Date().toISOString(),vendor:$('#vendorName').value.trim(),
    month:$('#paymentMonth').value,collector:$('#collectorName').value.trim(),method:$('#paymentMethod').value,
    checkNo:$('#checkNo').value.trim(),dueDate:$('#dueDate').value,gross,adjustment:adj,deductions:rows,
    deductionTotal,net,checkPhoto:checkPhotoData,invoicePhotos,notes:$('#notes').value.trim(),
    signature:signatureData,status:'已簽收'
  });
  saveDB();$('#paymentDialog').close();alert('付款簽收單已儲存');
});

$('#exportBtn').onclick=()=>{
  const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),payments},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`雙發付款簽收備份_${todayISO()}.json`;a.click();URL.revokeObjectURL(a.href);
  alert('已產生備份檔。請在 iPhone「檔案」中選擇儲存到 iCloud Drive。');
};
$('#importInput').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;
  try{const data=JSON.parse(await file.text());if(!Array.isArray(data.payments))throw new Error();payments=data.payments;saveDB();alert('備份匯入完成')}
  catch{alert('備份檔格式不正確')}
};

let deferredPrompt;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('#installBtn').classList.remove('hidden')});
$('#installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();deferredPrompt=null}};
if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js').catch(()=>{})}
render();
