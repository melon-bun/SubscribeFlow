const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const profile=path.join(root,'runtime/m10-development');fs.mkdirSync(profile,{recursive:true});
const child=spawn(require('electron'),[root],{stdio:'inherit',env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:profile}});
child.on('close',code=>{process.exitCode=code ?? 1;});
