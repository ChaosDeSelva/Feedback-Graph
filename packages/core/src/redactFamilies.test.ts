import { expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';

/**
 * One case per family member the rules read by family (header names, secret names in any syntax, password arguments of
 * the commands that take one, Windows forms, vendor shapes, cookies, tokens a few words after a credential word, short
 * random passwords after a password label), and the look-alikes each family must leave alone. All values are fake.
 */
const hidden = (text: string, secret: string) => {
  const out = redactSecrets(text);
  expect(out).toContain('[REDACTED]');
  expect(out).not.toContain(secret);
  expect(redactSecrets(out)).toBe(out);
};

const PW = 'Vq7#mRz2Lp9x';
const HEX = '6f1c0b9e2d7a48c3a5e1f0d9b8c7a6e5';
const KEY = 'Zr4Wq8Ny2Xc6Vb0Mk3Jh7Gf1Ds5';

test.each([
  [`curl -H "X-Auth-Key: ${HEX}" https://api.cloudflare.com/client/v4/zones`, HEX],
  [`curl -H 'Fastly-Key: ${KEY}' -X POST https://api.fastly.com/purge`, KEY],
  [`-H "DD-APPLICATION-KEY: ${HEX}"`, HEX],
  [`--header 'x-honeycomb-team: ${KEY}'`, KEY],
  [`X-JFrog-Art-Api: ${KEY}${KEY}`, KEY],
  [`Private-Token: ${KEY}`, KEY],
  [`headers = {"X-Api-Secret": "${KEY}"}`, KEY],
  [`Invoke-RestMethod -Headers @{ "X-Api-Key" = "${KEY}" }`, KEY],
  [`Authorization: token ${KEY}`, KEY],
  [`Authorization: ApiKey ${KEY}==`, KEY],
  ['Authorization: Splunk 46c91398-7bc0-4016-9301-fa012ed589ce', 'fa012ed589ce'],
  [`Proxy-Authorization: Basic ${KEY}/+x9`, KEY],
  [`Cookie: sessionid=${HEX}; theme=dark`, HEX],
  [`Set-Cookie: connect.sid=s%3A${KEY}.${KEY}; Path=/; HttpOnly`, KEY],
])('a header named for a credential, Authorization with any scheme and a session cookie are redacted: %s', hidden);

test.each([
  [`SMTP_PASS=${PW}`, PW],
  [`REDIS_PASS: ${PW}`, PW],
  [`ORACLE_PWD=${PW}`, PW],
  [`  LDAP_BIND_PW: "${PW}"`, PW],
  [`TF_VAR_db_pass=${PW}`, PW],
  [`web01 ansible_become_password=${PW}`, PW],
  [`    storePassword "${PW}"`, PW],
  [`<add key="ClearTextPassword" value="${PW}" />`, PW],
  [`  pass: ${PW}`, PW],
  [`spring.datasource.password=*${PW}`, PW],
  [`APP_KEY=base64:${KEY}${KEY}=`, KEY],
  [`HMAC_KEY=${HEX}`, HEX],
  [`app.config["SECRET_KEY"] = "${KEY}"`, KEY],
  [`NEO4J_AUTH: neo4j/${PW}`, PW],
  [`val adminPass = "${PW}"`, PW],
  [`credentials += Credentials("Nexus", "nexus.example.com", "deployer", "${PW}")`, PW],
  [`[Environment]::SetEnvironmentVariable("API_KEY", "${KEY}", "User")`, KEY],
  [`set DB_PASSWORD=${PW}`, PW],
  [`AZURE_DEVOPS_PAT=${KEY}`, KEY],
  [`<AdministratorPassword>${PW}</AdministratorPassword>`, PW],
  [`<property name="password" value="${PW}"/>`, PW],
  [`<entry key="db.password">${PW}</entry>`, PW],
  [`  admin_pwd => '${PW}',`, PW],
  [`set :deploy_password, '${PW}'`, PW],
  [`passkey=${HEX}`, HEX],
  [`mistral_key = "${KEY}"`, KEY],
  [`setx API_TOKEN "${KEY}"`, KEY],
  [`setx DB_PASSWORD ${PW}`, PW],
  [`set -gx GITHUB_TOKEN ${KEY}`, KEY],
  [`PASSPHRASE ${PW}`, PW],
  [`    password ${PW};`, PW],
  [`"private_key_id": "${HEX}",`, HEX],
  [`db_pass := ${PW}`, PW],
])('a value given to a name ending in a credential word, in any syntax, is redacted: %s', hidden);

test.each([
  [`cqlsh 10.0.0.4 -u cassandra -p ${PW}`, PW],
  [`mosquitto_pub -h broker -u iot -P ${PW} -t t -m hi`, PW],
  [`snmpwalk -v3 -u admin -A ${PW} -X ${PW}x 10.0.0.1`, PW],
  [`sqlplus scott/${PW}@ORCL`, PW],
  [`sqlcmd -S db -U sa -P '${PW}' -Q "select 1"`, PW],
  [`keytool -importkeystore -srcstorepass ${PW}a -deststorepass ${PW}`, PW],
  [`zip -P ${PW} backup.zip dump.sql`, PW],
  [`7z a -p${PW} secrets.7z ./dir`, PW],
  [`curl -u 'admin:${PW}' https://jenkins.example.com`, PW],
  [`curl --user "svc:${PW}" https://nexus.example.com`, PW],
  [`curl -sS -uadmin:${PW} https://es:9200`, PW],
  [`http -a admin:${PW} POST https://api.example.com/x`, PW],
  [`lftp -u backup,${PW} sftp://nas.local`, PW],
  [`xcrun altool --upload-app -f App.ipa -u dev@example.com -p ${PW}`, PW],
  [`aws ssm put-parameter --name /db --type SecureString --value ${KEY}`, KEY],
  [`./codecov -t 46c91398-7bc0-4016-9301-fa012ed589ce`, 'fa012ed589ce'],
  [`fly secrets set STRIPE_KEY=${KEY}`, KEY],
  [`aws configure set aws_secret_access_key ${KEY}`, KEY],
  [`b2 authorize-account 0012a07037a4 K001${KEY}`, KEY],
  [`redis-cli --pass "${PW}" info`, PW],
  [`echo '${PW}' | sudo -S apt update`, PW],
  [`az devops login --organization https://dev.azure.com/x <<< ${KEY}`, KEY],
  [`./manage --admin-pass ${PW}`, PW],
  [`curl -k --user admin:'${PW}' https://router/api`, PW],
  [`sqlcmd -S . -U sa -P"${PW}"`, PW],
  [`sshpass -p${PW} scp f host:`, PW],
  [`nmcli dev wifi connect HomeNet password ${PW}`, PW],
  [`wpa_passphrase HomeNet ${PW}`, PW],
  [`mosquitto_passwd -b /etc/mosquitto/pw iot ${PW}`, PW],
  [`rabbitmqctl change_password deploy ${PW}`, PW],
  [`rclone config create b2remote b2 account 001x key ${PW}`, PW],
  [`PsExec.exe \\\\host -u admin -p "${PW}" -s cmd`, PW],
])('the password argument of a command that takes one is redacted: %s', hidden);

test.each([
  [`$sec = ConvertTo-SecureString "${PW}" -AsPlainText -Force`, PW],
  [`New-LocalUser -Name svc -Password (ConvertTo-SecureString "${PW}" -AsPlainText -Force)`, PW],
  [`cmdkey /generic:TERMSRV/host /user:admin /pass:${PW}`, PW],
  [`psexec \\\\srv01 -u CORP\\admin -p ${PW} cmd`, PW],
  [`schtasks /create /tn Backup /tr C:\\b.bat /sc daily /ru svc /RP ${PW}`, PW],
  [`net use Z: \\\\fs01\\share ${PW} /user:CORP\\alice`, PW],
  [`net use \\\\fs01\\ipc$ /user:admin "%${PW}"`, PW],
  [`<Password>\n  <Value>${PW}</Value>\n  <PlainText>true</PlainText>\n</Password>`, PW],
  [`sc.exe config svc obj= CORP\\svc password= ${PW}`, PW],
])('a Windows or PowerShell password is redacted: %s', hidden);

test.each([
  [`asana token 1/2606412818793111:${HEX}`, HEX],
  [`AIRTABLE_API_KEY=patAbCdEf12345678.${HEX}${HEX}`, HEX],
  [`const resend = new Resend('re_Wb9zcJ2H_${KEY}');`, KEY],
  ['LDClient.init("sdk' + '-21ed85d7-522d-43e5-a06d-0ae18cf621fe")', '0ae18cf621fe'],
  ['SUAARK2GSQDCFSF6PZEDV2LRAJVB' + 'XKZY3IAS65BNKQ3O3C3GGKGAJENJ', 'SUAARK2GSQDCFSF6PZEDV2L'],
  [`https://example.webhook.office.com/webhookb2/${HEX}@${HEX}/IncomingWebhook/${HEX}/x`, HEX],
  ['PASS oauth' + ':3b904eg5pq0xrhu14lrrwysnlyofs4', '3b904eg5pq0xrhu14lrrwysnlyofs4'],
  [`https://api.openweathermap.org/data/2.5/weather?q=Oslo&appid=${HEX}`, HEX],
  [`netlify nfp_${KEY}`, KEY],
  [`posthog personal key phx_${KEY}`, KEY],
])('a vendor token shape is redacted whole: %s', hidden);

test.each([
  [`the staging api token is ${KEY}, rotate it monthly`, KEY],
  [`Here's the access key ${HEX} (don't share)`, HEX],
  [`creds are admin / ${PW}`, PW],
  [`my bearer is ${KEY}`, KEY],
  [`signing key => ${KEY}`, KEY],
  ['private key: 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'],
])('a token a few words after a credential word is redacted: %s', hidden);

test.each([
  'ssh -p 2222 deploy@host', 'docker run -p 8080:80 nginx', 'psql -h db -p 5432 -U app', 'mysql -h db -P 3306 -u root -p',
  'redis-cli -p 6380 ping', 'mosquitto_sub -h broker -p 1883 -t x', 'ldapsearch -x -W -D cn=admin', 'scp -P 2222 file host:',
  'curl -u "$USER:$PASS" https://x', 'curl --user "${API_USER}:${API_PASSWORD}" https://x', 'sqlplus / as sysdba', 'sqlplus /nolog',
  'net use Z: \\\\fs01\\share /persistent:yes', 'cmdkey /list', 'ConvertTo-SecureString $plain -AsPlainText -Force',
  'heroku config:set NODE_ENV=production LOG_LEVEL=debug', 'aws configure set region us-east-1', 'echo "done" | tee log.txt',
  'Authorization: Bearer <token>', 'Authorization: Bearer ${TOKEN}', 'X-Api-Key: $API_KEY', 'x-honeycomb-team: YOUR_API_KEY',
  'X-Auth-Key: {{ cloudflare_api_key }}', 'Idempotency-Key: 1f9c0b1e-8a7d-4c53-9d8e-2b4f6a1c3e7d', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  '"orders-api": "TRACE_SAMPLE=1",', 'Set-Cookie: theme=dark; Path=/', 'Cookie: <session cookie>', 'cookie:"cookies",cupcake:"cupcakes"',
  'SMTP_PASS=', 'SMTP_PASS=${SMTP_PASS}', 'pass: true', 'pass: "tool_round"', 'PASS: `cached`/`stale` are computed', 'bypass: abc123def',
  'passwd: required', 'auth: basic', '{"auth":"required","mode":"basic"}', 'oauth: enabled', 'require_auth=scram-sha-256',
  'storePassword System.getenv("STORE_PASSWORD")', "const storageKey = 'acme.settings.v2';", 'AccountKey: "001Example1000000A",',
  '_REINDEX_ADVISORY_LOCK_KEY = 512_903_771_604_238', 'CACHE_KEY=v1-deps-abc123', '<password>${env.MAVEN_PASSWORD}</password>',
  '<add key="ClearTextPassword" value="%NUGET_PW%" />', 'session_key: :_app_session', 'token: "REPLACE_ME"', '"Cask token: #{token}"',
  'async def fetch_profile(token: OAuth2Token) -> ProfileResponse:', 'public async connectCalendar(teamId: string, token: OAuth2Tokens) {',
  'ResourceReturnTypeToken: D3D10_SB_RESOURCE_RETURN_TYPE,', 'self.push_token(Token::Literal(\'[\'))',
  '[1Password for secrets](https://www.notion.so/team/1Password-for-secrets-1c535ab2169e44f2aeccb37b7f3373a3)',
  'const ownerCredential = !!auth.ownerToken && tokenMatches(bearer, auth.ownerToken);', 'The token expires after 24 hours.',
  'password: changeme', 'password: required', 'password: optional',
  '{RecordKey: "006DemoDealA10000A", Name: ptr("Spring renewal"),', 'UserKey: "005SampleRepUser0A", OpportunityKey: "006SampleDeal000AA",',
  'func (s *Store) persistToken(token *oauth2.Token) error {', "['docker login -p', 'docker login -u robot -p [REDACTED] registry.test'],",
  '<Password><Value>*SENSITIVE*DATA*DELETED*</Value></Password>', 'token string,', 'set -gx PATH $HOME/bin', 'password required', 'auth basic',
  'request.basic_auth Gem::UriFormatter.new(@uri.user).unescape,', '\ttoken string', 'nmcli connection up HomeNet', 'rclone config create remote drive scope drive',
])('a port flag, placeholder, reference, identifier or ordinary word stays: %s', (line) => expect(redactSecrets(line)).toBe(line));

/** mulberry32: a seeded generator, so the sample (and the test) is the same on every run. */
function generator(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random letter passwords of 8-15 after a password label are redacted, all but about 1 in 10 of 8 letters', () => {
  const next = generator(17);
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const [label, end] of [['password: ', ''], ['--password ', ''], ['"password": "', '"'], ['DB_PASS=', ''], ['pwd=', ';']]) {
    for (const length of [8, 11, 14]) {
      let kept = 0;
      for (let i = 0; i < 400; i++) {
        const v = Array.from({ length }, () => letters[Math.floor(next() * letters.length)]).join('');
        if (redactSecrets(`${label}${v}${end}`).includes(v)) kept++;
      }
      expect(kept, `${label}${length} letters`).toBeLessThan(length === 8 ? 60 : 30);
    }
  }
});

test.each([
  ['SG' + '.g1uIDV1Lkurpv4hCiHAGeN.uAAEFkbv2frPEvLTHz6REBT5eMbo1Z8ZjRJbeCq5Qj-', 'uAAEFkbv2frPEvLTHz6REBT5eMbo1Z8ZjRJbeCq5Qj-'],
  ['user.setPassword("Qm7vZ2kR9pLx4T");', 'Qm7vZ2kR9pLx4T'],
  ['Client.builder().password("Qm7vZ2kR9pLx4T").build()', 'Qm7vZ2kR9pLx4T'],
  ['option.WithAPIKey("tpuf_Qm7vZ2kR9pLx4T")', 'tpuf_Qm7vZ2kR9pLx4T'],
  ['signingConfigs { release { storePassword "Qm7vZ2kR9pLx4T"; keyPassword "rT5!kq8Lm2#Wz" } }', 'Qm7vZ2kR9pLx4T'],
  ['signingConfigs { release { storePassword "Qm7vZ2kR9pLx4T"; keyPassword "rT5!kq8Lm2#Wz" } }', 'rT5!kq8Lm2#Wz'],
  ['FLY_API_TOKEN="FlyV1 fm2' + '_lJPECAAAAAAAAMkhxBDRBk3bG0ZMSnxj2jT5Ty0dwrVodHRwczovL2FwaS5mbHkuaW8vdjGWAJLOAAtyqx8L"', 'lJPECAAAAAAAAMkhxBDRBk3bG0ZMSnxj2jT5Ty0dwrVodH'],
  ['pscale auth with pscale' + '_tkn_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd'],
  ['api: key' + '-8d5084ffb8101116c2a09eca036fbc45', '8d5084ffb8101116c2a09eca036fbc45'],
  ['Authorization: Digest username="alice", realm="x", nonce="abc", uri="/", response="6629fae49393a05397450978507c4ef1"', '6629fae49393a05397450978507c4ef1'],
])('a vendor token, setter, inline Gradle password or Digest response is redacted: %s', (text, secret) => hidden(text, secret));

test('Digest auth keeps its user name, and a URL query secret stops at the bracket that closes the link', () => {
  expect(redactSecrets('Authorization: Digest username="alice", response="6629fae49393a05397450978507c4ef1"'))
    .toBe('Authorization: Digest username="alice", response="[REDACTED]"');
  expect(redactSecrets('[![cov](https://cov.io/gh/a/b/badge.svg?token=nKkVklTFdA)](https://cov.io/gh/a/b)'))
    .toBe('[![cov](https://cov.io/gh/a/b/badge.svg?token=[REDACTED])](https://cov.io/gh/a/b)');
});

test.each([
  'const token = getToken("Qm7vZ2kR9pLx4T");', 'if (!user.verifyPassword("Qm7vZ2kR9pLx4T")) fail()', 'option.WithAPIKey("tpuf_A1..."),',
  'cache-key' + '-8d5084ffb8101116c2a09eca036fbc45', 'user.setPassword("secret")',
])('a getter, a check, an elided example or a longer name stays: %s', (line) => expect(redactSecrets(line)).toBe(line));
