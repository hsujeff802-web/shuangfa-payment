const $=s=>document.querySelector(s);
const dbKey='shuangfa_vendor_payments_v4';
let payments=JSON.parse(localStorage.getItem(dbKey)||'[]');
let signatureData='',invoicePhotos=[],checkPhotoData='',hasInk=false,formWasOpen=false;

function money(n){return new Intl.NumberFormat('zh-TW',{style:'currency',currency:'TWD',maximumFractionDigits:0}).format(Number(n||0))}
function saveDB(){localStorage.setItem(dbKey,JSON.stringify(payments));render()}
function render(){
 const now=new Date(),ym=now.toISOString().slice(0,7);
 $('#monthTotal').textContent=money(payments.filter(p=>p.createdAt.slice(0,7)===ym).reduce((s,p)=>s+p.net,0));
 $('#pendingSign').textContent=payments.filter(p=>!p.signature).length;
 $('#completed').textContent=payments.filter(p=>p.status==='已簽收').length;
 const soon=payments.filter(p=>{if(!p.dueDate)return false;const d=(new Date(p.dueDate+'T23:59:59')-now)/86400000;return d>=0&&d<=7});
 $('#dueSoon').textContent=soon.length;
 $('#dueList').className='list'+(soon.length?'':' empty');
 $('#dueList').innerHTML=soon.length?soon.map(p=>`<div class="payment-item"><div class="payment-top"><div><h3>${p.vendor}</h3><div class="meta">票號：${p.checkNo||'未填'}<br>到期日：${p.dueDate}</div></div><div class="amount">${money(p.net)}</div></div></div>`).join(''):'目前沒有即將到期的支票';
 const q=$('#searchInput').value.trim().toLowerCase();
 const list=payments.filter(p=>[p.vendor,p.checkNo,p.month,p.collector].join(' ').toLowerCase().includes(q));
 $('#paymentList').className='list'+(list.length?'':' empty');
 $('#paymentList').innerHTML=list.length?list.slice().reverse().map(p=>`<div class="payment-item"><div class="payment-top"><div><h3>${p.vendor}</h3><div class="meta">收款月份：${p.month}<br>票號：${p.checkNo||'—'}｜到期：${p.dueDate||'—'}<br>扣款：${money(p.deductionTotal)}</div><span class="badge">已手寫簽收</span></div><div class="amount">${money(p.net)}</div></div></div>`).join(''):'尚無資料';
}
function addDeduction(){const node=$('#deductionTemplate').content.cloneNode(true),row=node.querySelector('.deduction-row');row.querySelectorAll('input').forEach(i=>i.addEventListener('input',calc));row.querySelector('.remove-row').onclick=()=>{row.remove();calc()};$('#deductionRows').appendChild(node)}
function calc(){const g=Number($('#grossAmount').value||0),a=Number($('#adjustmentAmount').value||0),d=[...document.querySelectorAll('.deduction-amount')].reduce((s,i)=>s+Number(i.value||0),0);$('#grossDisplay').textContent=money(g);$('#deductionDisplay').textContent=money(d);$('#netDisplay').textContent=money(g+a-d)}
function resetForm(){$('#paymentForm').reset();$('#paymentMonth').value=new Date().toISOString().slice(0,7);$('#deductionRows').innerHTML='';addDeduction();signatureData='';checkPhotoData='';invoicePhotos=[];hasInk=false;$('#checkPreview').src='';$('#invoicePreview').innerHTML='';$('#signStatus').textContent='尚未簽名';calc()}
$('#newPaymentBtn').onclick=()=>{resetForm();$('#paymentDialog').showModal()}
$('#closeDialog').onclick=()=>$('#paymentDialog').close()
$('#addDeductionBtn').onclick=addDeduction
$('#grossAmount').addEventListener('input',calc);$('#adjustmentAmount').addEventListener('input',calc);$('#searchInput').addEventListener('input',render)
function fileToData(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file)})}
$('#checkPhoto').onchange=async e=>{if(e.target.files[0]){checkPhotoData=await fileToData(e.target.files[0]);$('#checkPreview').src=checkPhotoData}}
$('#invoicePhoto').onchange=async e=>{invoicePhotos=await Promise.all([...e.target.files].map(fileToData));$('#invoicePreview').innerHTML=invoicePhotos.map(x=>`<img src="${x}">`).join('')}

const screen=$('#signatureScreen'),canvas=$('#signatureCanvas'),ctx=canvas.getContext('2d');
let drawing=false;
function sizeCanvas(){
 const r=canvas.getBoundingClientRect(),ratio=Math.max(1,window.devicePixelRatio||1);
 canvas.width=Math.max(1,Math.floor(r.width*ratio));canvas.height=Math.max(1,Math.floor(r.height*ratio));
 ctx.setTransform(ratio,0,0,ratio,0,0);ctx.lineWidth=3;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#111';hasInk=false;
}
function pos(x,y){const r=canvas.getBoundingClientRect();return{x:x-r.left,y:y-r.top}}
function begin(x,y,e){drawing=true;hasInk=true;const p=pos(x,y);ctx.beginPath();ctx.moveTo(p.x,p.y);if(e)e.preventDefault()}
function draw(x,y,e){if(!drawing)return;const p=pos(x,y);ctx.lineTo(p.x,p.y);ctx.stroke();if(e)e.preventDefault()}
function end(e){drawing=false;if(e)e.preventDefault()}
canvas.addEventListener('touchstart',e=>{const t=e.touches[0];begin(t.clientX,t.clientY,e)},{passive:false});
canvas.addEventListener('touchmove',e=>{const t=e.touches[0];draw(t.clientX,t.clientY,e)},{passive:false});
canvas.addEventListener('touchend',end,{passive:false});
canvas.addEventListener('mousedown',e=>begin(e.clientX,e.clientY,e));
canvas.addEventListener('mousemove',e=>draw(e.clientX,e.clientY,e));
window.addEventListener('mouseup',end);
if(window.PointerEvent){
 canvas.addEventListener('pointerdown',e=>begin(e.clientX,e.clientY,e),{passive:false});
 canvas.addEventListener('pointermove',e=>draw(e.clientX,e.clientY,e),{passive:false});
 canvas.addEventListener('pointerup',end,{passive:false});
}
$('#openSignatureBtn').onclick=()=>{
 formWasOpen=$('#paymentDialog').open;
 if(formWasOpen)$('#paymentDialog').close();
 document.body.classList.add('signature-open');
 screen.classList.remove('hidden');
 setTimeout(sizeCanvas,250);
}
function returnToForm(){
 screen.classList.add('hidden');
 document.body.classList.remove('signature-open');
 if(formWasOpen)setTimeout(()=>$('#paymentDialog').showModal(),50);
}
$('#exitSignature').onclick=returnToForm;
$('#clearSignature').onclick=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);hasInk=false;signatureData='';$('#signStatus').textContent='尚未簽名'}
$('#confirmSignature').onclick=()=>{
 if(!hasInk){alert('簽名區目前是空白，請先簽名');return}
 signatureData=canvas.toDataURL('image/png');
 $('#signStatus').textContent='已完成廠商手寫簽名';
 returnToForm();
}

$('#paymentForm').addEventListener('submit',e=>{
 e.preventDefault();
 const rows=[...document.querySelectorAll('.deduction-row')].map(r=>({name:r.querySelector('.deduction-name').value.trim(),note:r.querySelector('.deduction-note').value.trim(),amount:Number(r.querySelector('.deduction-amount').value||0)})).filter(x=>x.name||x.note||x.amount);
 const gross=Number($('#grossAmount').value||0),adj=Number($('#adjustmentAmount').value||0),deductionTotal=rows.reduce((s,x)=>s+x.amount,0),net=gross+adj-deductionTotal;
 if(!signatureData){alert('請先讓廠商完成手寫簽名');return}
 payments.push({id:(crypto.randomUUID?crypto.randomUUID():Date.now().toString()),createdAt:new Date().toISOString(),vendor:$('#vendorName').value.trim(),month:$('#paymentMonth').value,collector:$('#collectorName').value.trim(),method:$('#paymentMethod').value,checkNo:$('#checkNo').value.trim(),dueDate:$('#dueDate').value,gross,adjustment:adj,deductions:rows,deductionTotal,net,checkPhoto:checkPhotoData,invoicePhotos,notes:$('#notes').value.trim(),signature:signatureData,status:'已簽收'});
 saveDB();$('#paymentDialog').close();alert('付款簽收單已儲存');
});
$('#exportBtn').onclick=()=>{const blob=new Blob([JSON.stringify({version:4,exportedAt:new Date().toISOString(),payments},null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`雙發付款簽收備份_${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
$('#importInput').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const data=JSON.parse(await file.text());if(!Array.isArray(data.payments))throw new Error();payments=data.payments;saveDB();alert('備份匯入完成')}catch{alert('備份檔格式不正確')}}
render();
