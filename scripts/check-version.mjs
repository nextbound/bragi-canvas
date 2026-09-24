import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const read=name=>JSON.parse(readFileSync(name,'utf8'))
const manifest=read('manifest.json'),pkg=read('package.json'),lock=read('package-lock.json'),versions=read('versions.json')
assert.match(manifest.version,/^\d+\.\d+\.\d+$/)
for(const version of [pkg.version,lock.version,lock.packages[''].version])assert.equal(version,manifest.version)
assert.equal(versions[manifest.version],manifest.minAppVersion)
if(process.env.GITHUB_REF_TYPE==='tag')assert.equal(process.env.GITHUB_REF_NAME,manifest.version)
assert.ok(readFileSync('CHANGELOG.md','utf8').includes(`## ${manifest.version}`),'Changelog must include the release version')
console.log(`Version ${manifest.version} consistent across manifest, package, lock and compatibility list.`)
