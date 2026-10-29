
const express=require('express'),http=require('http'),{Server}=require('socket.io'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const app=express(),server=http.createServer(app),io=new Server(server,{cors:{origin:true}});
app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(req,res)=>res.json({ok:true}));
const DATA=process.env.DATA_DIR||path.join(__dirname,'data');fs.mkdirSync(DATA,{recursive:true});
const questionFile=path.join(DATA,'questions.json');
const defaults=[
{q:'PROMPT ย่อมาจากชื่อหน่วยงานใด?',a:['ศูนย์สุขภาพพร้อม','ศูนย์กีฬา','ศูนย์เทคโนโลยี','ศูนย์การศึกษา'],correct:0},
{q:'การทำงานเป็นทีมตรงกับคำใด?',a:['Team Work','Safety Culture','Service Mind','Innovation'],correct:0},
{q:'ในเกมนี้มีเวลาตอบคำถามข้อละกี่วินาที?',a:['10','15','20','30'],correct:1}
];
let questions=defaults;try{questions=JSON.parse(fs.readFileSync(questionFile,'utf8'));}catch{}
const rooms=new Map();
const clean=(s,n=70)=>String(s||'').trim().slice(0,n);
function state(r){return {pin:r.pin,phase:r.phase,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,order:p.order,score:p.score,connected:p.connected})),questionCount:r.questions.length,index:r.index,endsAt:r.endsAt,answered:r.answers.size};}
function rankings(r){return [...r.players.values()].sort((a,b)=>b.score-a.score||a.order-b.order).map((p,i)=>({rank:i+1,name:p.name,score:p.score,order:p.order}));}
function emitState(r){io.to(r.pin).emit('state',state(r));}
function finishQuestion(r){if(r.phase!=='question')return;clearTimeout(r.timer);r.phase='reveal';r.endsAt=null;let q=r.questions[r.index];io.to(r.pin).emit('reveal',{correct:q.correct,answer:q.a[q.correct],rankings:rankings(r)});emitState(r);}
function next(r){clearTimeout(r.timer);r.answers.clear();r.index++;if(r.index>=r.questions.length){r.phase='finished';r.endsAt=null;const results=rankings(r);fs.writeFileSync(path.join(DATA,`results-${r.pin}-${Date.now()}.json`),JSON.stringify({pin:r.pin,results},null,2));io.to(r.pin).emit('finished',{rankings:results});emitState(r);return;}
r.phase='question';r.endsAt=Date.now()+15000;let q=r.questions[r.index];io.to(r.pin).emit('question',{index:r.index,total:r.questions.length,q:q.q,a:q.a,endsAt:r.endsAt});emitState(r);r.timer=setTimeout(()=>finishQuestion(r),15000);}
function auth(socket,pin,token){let r=rooms.get(clean(pin,6));return r&&r.adminToken===token&&r.adminSocket===socket.id?r:null;}
io.on('connection',socket=>{
socket.on('create',(_,cb)=>{let pin;do{pin=String(Math.floor(100000+Math.random()*900000));}while(rooms.has(pin));const token=crypto.randomBytes(24).toString('hex');const r={pin,adminToken:token,adminSocket:socket.id,players:new Map(),phase:'lobby',questions:JSON.parse(JSON.stringify(questions)),index:-1,answers:new Map(),endsAt:null,timer:null};rooms.set(pin,r);socket.join(pin);socket.data.admin=pin;cb({ok:true,pin,token,questions:r.questions});emitState(r);});
socket.on('join',({pin,name,id},cb)=>{let r=rooms.get(clean(pin,6));name=clean(name,32);if(!r)return cb({error:'ไม่พบห้องเกม'});if(!name)return cb({error:'กรุณากรอกชื่อ'});let p=id&&r.players.get(id);if(!p){if(r.phase!=='lobby')return cb({error:'เกมเริ่มแล้ว ไม่สามารถเข้าร่วมใหม่ได้'});if(r.players.size>=200)return cb({error:'ห้องเต็ม (200 คน)'});if([...r.players.values()].some(x=>x.name.toLowerCase()===name.toLowerCase()))return cb({error:'ชื่อนี้ถูกใช้แล้ว'});id=crypto.randomUUID();p={id,name,order:r.players.size+1,score:0,connected:true,socketId:socket.id};r.players.set(id,p);}else{p.connected=true;p.socketId=socket.id;}
socket.join(r.pin);socket.data.player={pin:r.pin,id};cb({ok:true,id,name:p.name,order:p.order,phase:r.phase});emitState(r);
if(r.phase==='question'){const q=r.questions[r.index];socket.emit('question',{index:r.index,total:r.questions.length,q:q.q,a:q.a,endsAt:r.endsAt});if(r.answers.has(id))socket.emit('answerAck',{score:p.score});}
if(r.phase==='reveal'){let q=r.questions[r.index];socket.emit('reveal',{correct:q.correct,answer:q.a[q.correct],rankings:rankings(r)});}
if(r.phase==='finished')socket.emit('finished',{rankings:rankings(r)});
});
socket.on('answer',({choice},cb)=>{let info=socket.data.player,r=info&&rooms.get(info.pin),p=r&&r.players.get(info.id);if(!r||!p||p.socketId!==socket.id||r.phase!=='question'||Date.now()>r.endsAt||r.answers.has(info.id))return cb?.({error:'ไม่สามารถส่งคำตอบได้'});choice=Number(choice);if(!Number.isInteger(choice)||choice<0||choice>=r.questions[r.index].a.length)return cb?.({error:'คำตอบไม่ถูกต้อง'});r.answers.set(info.id,choice);const correct=choice===r.questions[r.index].correct;if(correct)p.score+=500+Math.floor(500*Math.max(0,r.endsAt-Date.now())/15000);socket.emit('answerAck',{score:p.score});cb?.({ok:true});emitState(r);if(r.answers.size===r.players.size)finishQuestion(r);});
socket.on('setQuestions',({pin,token,questions:qs},cb)=>{let r=auth(socket,pin,token);if(!r)return cb({error:'ไม่มีสิทธิ์'});if(r.phase!=='lobby')return cb({error:'แก้คำถามได้ก่อนเริ่มเกมเท่านั้น'});if(!Array.isArray(qs)||!qs.length||qs.length>100||!qs.every(q=>typeof q.q==='string'&&q.q.trim()&&Array.isArray(q.a)&&q.a.length===4&&q.a.every(a=>typeof a==='string'&&a.trim())&&Number.isInteger(q.correct)&&q.correct>=0&&q.correct<4))return cb({error:'คำถามต้องมี 1–100 ข้อ แต่ละข้อมี 4 ตัวเลือกและคำตอบที่ถูกต้อง'});r.questions=qs.map(q=>({q:clean(q.q,500),a:q.a.map(a=>clean(a,250)),correct:q.correct}));questions=r.questions;fs.writeFileSync(questionFile,JSON.stringify(questions,null,2));cb({ok:true});emitState(r);});
socket.on('start',({pin,token},cb)=>{let r=auth(socket,pin,token);if(!r)return cb({error:'ไม่มีสิทธิ์'});if(r.phase!=='lobby')return cb({error:'เริ่มเกมไปแล้ว'});if(!r.players.size)return cb({error:'ยังไม่มีผู้เล่น'});next(r);cb({ok:true});});
socket.on('next',({pin,token},cb)=>{let r=auth(socket,pin,token);if(!r)return cb({error:'ไม่มีสิทธิ์'});if(r.phase!=='reveal')return cb({error:'รอเฉลยก่อน'});next(r);cb({ok:true});});
socket.on('end',({pin,token},cb)=>{let r=auth(socket,pin,token);if(!r)return cb({error:'ไม่มีสิทธิ์'});clearTimeout(r.timer);r.phase='finished';io.to(pin).emit('finished',{rankings:rankings(r)});emitState(r);cb({ok:true});});
socket.on('disconnect',()=>{const info=socket.data.player,r=info&&rooms.get(info.pin),p=r&&r.players.get(info.id);if(p&&p.socketId===socket.id){p.connected=false;emitState(r);}const admin=socket.data.admin;if(admin&&rooms.has(admin)){const room=rooms.get(admin);if(room.adminSocket===socket.id){clearTimeout(room.timer);io.to(admin).emit('notice','ผู้จัดเกมออกจากห้อง ห้องนี้ถูกปิดแล้ว');rooms.delete(admin);}}});
});
server.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('PROMPT Quiz running'));
