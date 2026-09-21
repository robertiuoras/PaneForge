import test from 'node:test';
import assert from 'node:assert/strict';
import {externalOpenCommand} from '../server/local-apps.mjs';

test('report targets stay single arguments on macOS and Linux',()=>{
 const target='/tmp/a report & notes.html';
 assert.deepEqual(externalOpenCommand(target,'darwin'),['/usr/bin/open',[target]]);
 assert.deepEqual(externalOpenCommand(target,'linux'),['xdg-open',[target]]);
});

test('Windows opener encodes a literal target without invoking cmd or interpolating PowerShell',()=>{
 for(const target of [String.raw`C:\Users\Gamer\a report's & notes.html`, String.raw`C:\Users\Gamer\a’ report‘ & 日本語.html`, 'https://example.com/?q=$(whoami)&x="hello"', 'obsidian://open?vault=My%20Vault&file=note']){
  const [command,args]=externalOpenCommand(target,'win32');
  assert.equal(command,'powershell.exe');
  assert.deepEqual(args.slice(0,-1),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand']);
  const script=Buffer.from(args.at(-1),'base64').toString('utf16le');
  const payload=script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.ok(payload);
  assert.equal(Buffer.from(payload,'base64').toString('utf8'),target);
  assert.equal(script,`$ErrorActionPreference='Stop'; Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))`);
 }
});

test('invalid targets and unsupported hosts fail before requesting an opener',()=>{
 for(const target of ['',null,'https://example.com/\nnext','a\0b'])assert.throws(()=>externalOpenCommand(target,'win32'),/Invalid open target/);
 assert.throws(()=>externalOpenCommand('https://example.com','unknown'),/not supported/);
});
