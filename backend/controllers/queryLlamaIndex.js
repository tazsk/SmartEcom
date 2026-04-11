// queryLlamaIndex.js
import axios from 'axios';

// Configure via env when needed, e.g.:
//   LLAMA_URL=http://127.0.0.1:5001/query node index.js
const LLAMA_URL = process.env.LLAMA_URL || 'http://127.0.0.1:5001/query';

const client = axios.create({
  proxy: false,                   // don't send localhost through system/corp proxies
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

const queryLlamaIndex = async (query) => {
  try {
    if (!Array.isArray(query) || query.length === 0) {
      throw new Error('query must be a non-empty array');
    }

    console.log('[queryLlamaIndex] Using:', LLAMA_URL);
    const res = await client.post(LLAMA_URL, { query });
    const data = res.data;

    if (!data || !Array.isArray(data.matched_titles)) {
      throw new Error('Invalid response from Llama server');
    }

    return data.matched_titles;
  } catch (err) {
    console.error(
      'Error querying LlamaIndex:',
      err.response?.status ?? '',
      err.response?.data ?? err.message
    );
    throw err;
  }
};

export default queryLlamaIndex;
