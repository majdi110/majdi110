const fs = require('fs');
const path = require('path');

const REPO_ROOT  = '/home/genweb/public_html/datav.repo';
const QUEUE_DIR  = '/home/genweb/agent/queue';
const TOKEN_FILE = '/home/genweb/agent/ACTION_TOKEN';
const LIST_MAX_DEPTH = 3;
const GET_MAX_BYTES  = 256 * 1024;
const HIDDEN_DIRS = new Set(['.git','node_modules','.cache','.cpanel','.trash']);
const HIDDEN_TOP  = new Set(['.git','node_modules','.env']);

function readToken(){ try{ return fs.readFileSync(TOKEN_FILE,'utf8').trim(); }catch{ return ''; } }
function authOk(req,res){
  const expected = readToken();
  const h = req.headers.authorization || '';
  const tok = h.toLowerCase().startsWith('bearer ') ? h.slice(7) : '';
  if (expected && tok !== expected){ res.status(401).json({error:'Unauthorized'}); return false; }
  return true;
}
function endsWithNewline(s){ return s.endsWith('\n'); }
function safeJoin(root,user){
  const p = path.normalize('/'+String(user||'').replace(/^\/+/,'')); const full = path.join(root,'.'+p);
  if (!full.startsWith(root)) throw new Error('path traversal'); return full;
}
function isHiddenName(n){ return n.startsWith('.') && !['.htaccess','.htpasswd'].includes(n); }

module.exports = function(app){
  app.post('/ai2', (req,res)=>{
    if(!authOk(req,res))return;
    const {base_branch,message,diff,diff_b64}=req.body||{};
    if(!base_branch||typeof base_branch!=='string') return res.status(400).json({error:'Missing base_branch'});
    const msg=(typeof message==='string'&&message.trim())?message:'apply via API';
    let payload;
    if(typeof diff_b64==='string'){ try{ payload=Buffer.from(diff_b64,'base64').toString('utf8'); }catch{ return res.status(400).json({error:'diff_b64 not valid base64'}); } }
    else if(typeof diff==='string'){ payload=diff; } else return res.status(400).json({error:'Provide diff_b64 or diff'});
    if(!endsWithNewline(payload)) payload+='\n';
    try{ if(!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR,{recursive:true}); }catch{}
    try{ fs.accessSync(QUEUE_DIR,fs.constants.W_OK); }catch{ return res.status(500).json({error:'Queue not writable'}); }
    const job={ base_branch, message: msg, ...(typeof diff_b64==='string'?{diff_b64}:{diff:payload}) };
    const ts=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    const name=`job-${ts}.json`; const tmp=path.join('/tmp',`ai2job.${process.pid}.${Date.now()}.json`); const target=path.join(QUEUE_DIR,name);
    try{ fs.writeFileSync(tmp,JSON.stringify(job)); fs.renameSync(tmp,target);}catch(e){ try{fs.unlinkSync(tmp);}catch{} return res.status(500).json({error:'Failed to enqueue job'}); }
    res.status(202).json({queued:true,job:name,hint:'worker.sh will apply, commit and push'});
  });

  app.get('/ai2/fs/list',(req,res)=>{
    if(!authOk(req,res))return;
    const rel=String(req.query.path||''); let depth=parseInt(String(req.query.depth||'1'),10);
    if(isNaN(depth)||depth<0) depth=1; if(depth>LIST_MAX_DEPTH) depth=LIST_MAX_DEPTH;
    let root; try{ root=safeJoin(REPO_ROOT,rel);}catch{return res.status(400).json({error:'bad path'});}
    if(!fs.existsSync(root)) return res.json({path:rel,items:[]});
    function walk(dir,d,prefix){
      const out=[]; for(const e of fs.readdirSync(dir,{withFileTypes:true})){
        if(HIDDEN_DIRS.has(e.name)||HIDDEN_TOP.has(e.name)||isHiddenName(e.name)) continue;
        const abs=path.join(dir,e.name); const relp=path.posix.join(prefix,e.name);
        try{ const st=fs.statSync(abs); out.push({path:relp,type:e.isDirectory()?'dir':'file',size:st.size,mtime:Math.floor(st.mtimeMs/1000)});
          if(e.isDirectory()&&d>0) out.push(...walk(abs,d-1,relp));
        }catch{}
      } return out;
    }
    res.json({path:rel,items:walk(root,depth,rel.replace(/^\/+/,''))});
  });

  app.get('/ai2/fs/get',(req,res)=>{
    if(!authOk(req,res))return;
    const rel=String(req.query.path||''); let abs; try{ abs=safeJoin(REPO_ROOT,rel);}catch{return res.status(400).json({error:'bad path'});}
    if(!fs.existsSync(abs)) return res.status(404).json({er
    const st=fs.statSync(abs); if(!st.isFile()) return res.status(400).json({error:'not a file'});
    if(st.size>GET_MAX_BYTES) return res.status(413).json({error:'file too large',limit:GET_MAX_BYTES});
    const buf=fs.readFileSync(abs); res.json({path:rel,size:buf.length,mtime:Math.floor(st.mtimeMs/1000),content_b64:buf.toString('base64')});
  });
};
