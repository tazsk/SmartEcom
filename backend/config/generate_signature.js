import crypto from 'crypto'

// Your credentials
const consumerId = '06c0a486-c027-4438-84d0-61e0d10073e8';
const keyVersion = '1';

// Use a current timestamp or specify one
const timestamp = Date.now().toString();

// Create signature data (CORRECT FORMAT for Walmart Affiliate API)
// Format: WM_CONSUMER.ID + \n + WM_CONSUMER.TIMESTAMP + \n + WM_SEC.KEY_VERSION + \n
const signatureData = consumerId + '\n' + timestamp + '\n' + keyVersion + '\n';

// Paste your private key here (including the BEGIN and END lines)
const privateKey = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCpCPXDprAoUJdf
ebRz2zkjY2plQBczhJwa7O9sW7DvjgK2TI55Uus8E7goZDtHEcrXUpWFLn0ILV7h
UMzNl/iQvA2L3UIgQ+AASuccX9nYjLhBChUoSt30xoo0PM88gvMlmtCLlNKxPKHM
TTjmcjD1WzDuywvrsY4O1NaHvgmN6kDUGXfB9+gc4K+43YpAuFwDbGyLH3RVUX5R
cQcEkpqNujE0DnOaGZcQlvWlFuWFbyHaiQSxvabDpxOsIQx1mXEzkem2aOXTnHuW
vM3hgZUxvM61fUX1//MRohE6oidZwfYpdwKYIGsfcv3Q3VElfoFfnJjNoENa20Kk
4klJJPKpAgMBAAECggEANt3eLBYYetWB9O8juDFxz/9OgzP08/d41jKPGnx+p5tQ
XQzneBEGovcBoTa7mPt4/EBloRewZO2ZLQiVmaxY9d3chcgZVTDC7kVh0+923hf7
HL1hlbULa47gQEl2uP0GYG/qfkwdwYLdP9vW+tIY+yMQ9Im6wlPdOQoz4la4cjQO
rztnfH5KvUa7DP3SsoOdw3U5T25p1UBzZJhzDpOBljOX8hHlp95nbtohQ0VoCh/a
gqQ0aaSawbS1nyHxp+4YUNgF9M8Rm166NaplNK/vi2/SbkDqOZGUb1Oo7cKezDlN
7I8f2lcMnu4tM7xzIB20hc0ROJCQduplmU2hljmfiwKBgQDR034HfPMhBSm7FHp0
0BXocbTXicAMgFjCkGyGMkiXiNorwGyHMjav3kjARxrughYfKr2mvNJy2Y0ENgzE
mESsDA+1qu3faCR0DhOAcPGs4LpZgUxbHFqjR20NsIyaQKlNjfayXNE9Qk80HPj2
Y463opclIHdRae62JPX2pdzWFwKBgQDOO4IRTVGpgu9NaR0Q2dEWS900QOxXobng
XinhRSlzdAKEEZvfnbuxEa+L8XTskSGb4KnFx1IOJy6wdU7oj3En+AXr2l5Dml5b
+VG/lY3OAUQL5AIfSK08edWy7ztl/QZprn8u6LmX04PIt4ldXkO1KmZuHW5AF5qe
eHWHAcK1PwKBgDXnIwVBcCQXc3T/+cVwf3BLZa3JUXDkt+ijuX1wBX4IRiPfNwI0
QCBF9mKO4bhL6uruy/G9qEKg6L0gNX97roiUQKTm2F0AH/1AcHoaibtjr/u2X6s4
SYCQpM9Tf4tQ+S1XPvzrI0Wdd0Nn/f0t7kf2mOWMxZpAoHZiYF2Qln7ZAoGAd81b
7p8i3D0CtM5mIx7VdoVVmABLC1EYwH0TCRj7TmVK/NuZ2BoyKVejycDXcoGQq5Ok
LA9w3GXomnta/oAtdNGA5xTwg4cOX5GC6q9/M/fKRroKfY/jiukfuhV9RO7qpcPH
gEGTZt5phNURyBp1bK2X2UnhfPv5Ryuk4mukZ1MCgYBt4VNgIEiWy9fX1FQjWrQB
eNWtaI8i3o5u1ut9EVfXq6DMAfKIZpTZMIyIDz6h+pljaFW3qtylmgjoXO1/osmB
sbE07zb2P0PSv6/z/eIn/cLFe0h2VT+09zLSTnvEgIgM7Edye9yICPCpvYWEGAmf
fe3pObdDeM/HBGtrmrLpBg==
-----END PRIVATE KEY-----
`;

// Generate signature
const signature = crypto.sign('sha256', Buffer.from(signatureData, 'utf8'), privateKey);
const base64Signature = signature.toString('base64');

console.log('\n=== Copy these values to Postman ===');
console.log('WM_CONSUMER.ID:', consumerId);
console.log('WM_CONSUMER.TIMESTAMP:', timestamp);
console.log('WM_SEC.KEY_VERSION:', keyVersion);
console.log('WM_SEC.AUTH_SIGNATURE:', base64Signature);