const express=require('express');const http=require('http');const {Server}=require('socket.io');const path=require('path');const fs=require('fs');
const app=express();const server=http.createServer(app);const io=new Server(server);
app.use(express.static(__dirname,{index:'index.html'}));
const ROWS=5,COLS=6,TOTAL=30,TEAM_IDS=['t1','t2','t3','t4','t5','t6'],START_TROOPS=100,ZERO_BID_PENALTY=5,ADJACENCY_BONUS=10,BID_TIMEOUT=15000,TROOPS_PER_ROUND=10;
const HOST_PASSWORD=process.env.HOST_PASSWORD||'admin123';
const TEAM_ACCOUNTS={doi1:{teamId:'t1',password:'doi1@123'},doi2:{teamId:'t2',password:'doi2@123'},doi3:{teamId:'t3',password:'doi3@123'},doi4:{teamId:'t4',password:'doi4@123'},doi5:{teamId:'t5',password:'doi5@123'},doi6:{teamId:'t6',password:'doi6@123'}};
const QUESTIONS=JSON.parse(fs.readFileSync(path.join(__dirname,'data/questions.json'),'utf8'));let timer=null;
function shuffle(n){const a=Array.from({length:n},(_,i)=>i);for(let i=n-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function tiles(){const stars=[...Array(10).fill(10),...Array(10).fill(15),...Array(8).fill(20)],o=shuffle(TOTAL),sp=shuffle(TOTAL).slice(0,5),types=['treasure','treasure','delete','delete','swap'].concat(Array(TOTAL-5).fill('normal'));return o.map((x,i)=>{const t={idx:i,row:Math.floor(i/COLS),col:i%COLS,star:stars[x],baseStar:stars[x],type:types[x],owner:null,revealed:!1,bonus:!1,wrongAttempt:!1};return t})}
function teams(){return Object.fromEntries(TEAM_IDS.map((id,i)=>[id,{id,name:`Đội ${i+1}`,troops:START_TROOPS}]))}
function fresh(){return{phase:'lobby',round:0,tiles:tiles(),teams:teams(),bids:{},bidSubmitted:{},bidEndsAt:null,currentWinner:null,currentTileIdx:null,currentQuestionShown:null,lastAnswerCorrect:null,log:[],scoreboard:[],pendingSpecial:null,myBid:null}}
let G=fresh();
function bonuses(){const out=new Set(),own=i=>G.tiles[i].owner;for(let r=0;r<ROWS;r++){let st=0;for(let c=1;c<=COLS;c++){const cur=c<COLS?own(r*COLS+c):Symbol(),prev=own(r*COLS+c-1);if(cur!==prev){if(st>=3&&prev!==Symbol())for(let j=st-3;j<st;j++)out.add(r*COLS+prev+j-st)}st=cur!==prev?1:st+1}for(let c=1;c<=COLS;c++){const cur=c<COLS?own(r*COLS+c):Symbol(),prev=r>0?own((r-1)*COLS+c):Symbol();if(cur!==prev){if(st>=3&&prev!==Symbol())for(let j=st-3;j<st;j++)out.add((r-st)*COLS+prev+j*COLS-st*COLS)}}return out}
function score(id){const b=bonuses();return G.tiles.reduce((n,t)=>n+(t.owner===id?t.star+(b.has(t.idx)?ADJACENCY_BONUS:0):0),0)}
function board(){return TEAM_IDS.map(id=>({id,name:G.teams[id].name,troops:G.teams[id].troops,score:score(id)})).sort((a,b)=>b.score-a.score)}
function state(role,id){const b=bonuses();return{phase:G.phase,round:G.round,tiles:G.tiles.map(t=>({idx:t.idx,row:t.row,col:t.col,star:t.star,owner:t.owner,type:t.revealed?t.type:(t.owner?t.type:'hidden'),bonus:b.has(t.idx),wrongAttempt:t.wrongAttempt})),teams:G.teams,bids:role==='host'?G.bids:{},bidSubmitted:G.bidSubmitted,bidEndsAt:G.bidEndsAt,currentWinner:G.currentWinner,currentTileIdx:G.currentTileIdx,currentQuestion:role==='team'&&G.currentWinner===id&&G.currentQuestion?G.currentQuestion:null,lastAnswerCorrect:G.lastAnswerCorrect,log:G.log,scoreboard:board(),pendingSpecial:role==='team'&&G.pendingSpecial?G.pendingSpecial:null,myBid:role==='team'?G.bids[id]:null}}
function broadcast(){for(const[,s]of io.of('/').sockets)if(s.data.role)s.emit('state',state(s.data.role,s.data.teamId))}
function log(x){G.log.push(x);if(G.log.length>50)G.log.shift()}
function clearTimer(){if(timer)clearTimeout(timer);timer=null}
function resolve(){if(G.phase!=='bidding')return;clearTimer();G.bidEndsAt=null;TEAM_IDS.forEach(id=>{if(!(id in G.bids))G.bids[id]=0});const max=Math.max(...TEAM_IDS.map(id=>G.bids[id])),top=TEAM_IDS.filter(id=>G.bids[id]===max)[0];TEAM_IDS.forEach(id=>{if(G.bids[id]===0){G.teams[id].troops-=ZERO_BID_PENALTY;log(`${G.teams[id].name} bị phạt ${ZERO_BID_PENALTY} quân (do đặt 0).`)}else G.teams[id].troops-=G.bids[id]});G.currentWinner=top;G.phase='tile_select';log(`${G.teams[top].name} thắng đấu giá với ${max} quân!`);broadcast()}
function round(){G.round++;TEAM_IDS.forEach(id=>{G.teams[id].troops+=TROOPS_PER_ROUND;log(`${G.teams[id].name} cộng ${TROOPS_PER_ROUND} quân.`)});G.bids={};G.bidSubmitted={};G.currentWinner=null;G.currentTileIdx=null;G.currentQuestion=null;G.currentQuestionShown=null;G.lastAnswerCorrect=null;G.pendingSpecial=null;G.phase='bidding';G.bidEndsAt=Date.now()+BID_TIMEOUT;timer=setTimeout(resolve,BID_TIMEOUT);log(`Vòng ${G.round} bắt đầu!`);broadcast()}
function finish(){G.phase='round_end';if(G.tiles.every(t=>t.owner!==null)){G.phase='game_over';log('Trận đấu kết thúc thắng công!')}}
function special(t){if(t.type==='treasure'){t.star=t.baseStar*2;log(`Ô ${t.idx+1} là kho báu 💰 — sao x2.`);finish()}else if(t.type==='delete'||t.type==='swap'){G.pendingSpecial={type:t.type,teamId:G.currentWinner};log(`${G.teams[G.currentWinner].name} chạm phải hiệu ứng: ${t.type==='delete'?'XÓA ĐẤT':'ĐỔI ĐẤT'}.`)}else finish()}
io.on('connection',s=>{s.data={role:null,teamId:null};s.on('join',({role,username,password})=>{if(role==='host'){if(password!==HOST_PASSWORD)return s.emit('joinError','Sai mật khẩu host.');s.data.role='host';s.emit('state',state('host',null));log('Ban tổ chức đã vào.');}else if(role==='team'){const acc=TEAM_ACCOUNTS[username];if(!acc||acc.password!==password)return s.emit('joinError','Sai tên hoặc mật khẩu đội');s.data.role='team';s.data.teamId=acc.teamId;s.emit('joined',{teamId:acc.teamId,teams:G.teams});s.emit('state',state('team',acc.teamId));log(`${G.teams[acc.teamId].name} (${username}) đã vào.`);}else if(role==='screen'){s.data.role='screen';s.emit('state',state('screen',null));log('Màn hình chiếu nay vào.')}broadcast()});

s.on('host:setTeamName',({teamId,name})=>{if(s.data.role==='host'&&G.teams[teamId]){G.teams[teamId].name=(name||'').slice(0,30)||G.teams[teamId].name;broadcast()}});

s.on('host:startGame',(()=>{if(s.data.role!=='host')return;G=fresh();log('Trận đấu mới bắt đầu!');round()}));

s.on('host:forceReveal',()=>{if(s.data.role!=='host'||G.phase!=='bidding')return;resolve()});

s.on('host:nextRound',()=>{if(s.data.role!=='host'||G.phase!=='round_end')return;G.phase==='game_over'?G=fresh():round()});

s.on('host:resetGame',()=>{if(s.data.role!=='host')return;G=fresh();log('Trận đấu reset.');broadcast()});

s.on('team:submitBid',({amount})=>{if(s.data.role!=='team'||G.phase!=='bidding'||G.bidSubmitted[s.data.teamId])return;const id=s.data.teamId;G.bids[id]=Math.max(0,Math.min(G.teams[id].troops,Math.floor(amount||0)));G.bidSubmitted[id]=!0;log(`${G.teams[id].name} đã đặt cược.`);const all=Object.keys(G.bidSubmitted).length;if(all===6)resolve();else broadcast()});

s.on('team:selectTile',({tileIdx})=>{if(s.data.role!=='team'||G.phase!=='tile_select'||G.currentWinner!==s.data.teamId||G.tiles[tileIdx].owner)return;G.tiles[tileIdx].owner=s.data.teamId;G.currentTileIdx=tileIdx;G.currentQuestion=QUESTIONS[tileIdx];G.phase='question';log(`${G.teams[s.data.teamId].name} chọn ô ${tileIdx+1}.`);broadcast()});

s.on('team:submitAnswer',({optionIndex})=>{if(s.data.role!=='team'||G.phase!=='question'||G.currentWinner!==s.data.teamId)return;const correct=QUESTIONS[G.currentTileIdx].correctIndex===optionIndex;G.lastAnswerCorrect=correct;G.tiles[G.currentTileIdx].revealed=!0;if(!correct)G.tiles[G.currentTileIdx].owner=null;G.tiles[G.currentTileIdx].wrongAttempt=!correct;const msg=correct?`${G.teams[s.data.teamId].name} trả lời đúng! 🎉`:`${G.teams[s.data.teamId].name} trả lời sai! ❌`;log(msg);if(correct)special(G.tiles[G.currentTileIdx]);else finish();broadcast()});

s.on('team:specialDelete',({tileIdx})=>{if(s.data.role!=='team'||G.phase!=='special'||!G.pendingSpecial||G.pendingSpecial.type!=='delete'||G.pendingSpecial.teamId!==s.data.teamId)return;G.tiles[tileIdx].owner=null;log(`${G.teams[s.data.teamId].name} xóa ô ${tileIdx+1}.`);G.pendingSpecial=null;finish();broadcast()});

s.on('team:specialSwap',({tileA,tileB})=>{if(s.data.role!=='team'||G.phase!=='special'||!G.pendingSpecial||G.pendingSpecial.type!=='swap'||G.pendingSpecial.teamId!==s.data.teamId)return;[G.tiles[tileA].owner,G.tiles[tileB].owner]=[G.tiles[tileB].owner,G.tiles[tileA].owner];log(`${G.teams[s.data.teamId].name} đổi ô ${tileA+1} và ô ${tileB+1}.`);G.pendingSpecial=null;finish();broadcast()});

s.on('disconnect',()=>{if(s.data.role==='host')log('Ban tổ chức đã ngắt kết nối.');else if(s.data.role==='team')log(`${G.teams[s.data.teamId].name} ngắt kết nối.`);else if(s.data.role==='screen')log('Màn hình chiếu ngắt kết nối.')})}); 
const PORT=process.env.PORT||3000;server.listen(PORT,'0.0.0.0',()=>console.log(`Chiếm Cứ Điểm chạy tại http://localhost:${PORT}`));
