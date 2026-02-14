// src/Context/ShopContext.js
import React, { createContext, useState, useEffect } from 'react';
import axios from 'axios';

const roundToTwoDecimals = (value) => Math.round(value * 100) / 100;

export const ShopContext = createContext();

const API_BASE = 'http://localhost:4000';

const ShopProvider = ({ children }) => {
  // --- Global app state ---
  const [user, setUser] = useState(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Store products & cart
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [totalCartValue, setTotalCartValue] = useState(0);
  const [orders, setOrders] = useState([]);

  // UI / errors
  const [error, setError] = useState('');
  const [tab, setTab] = useState(() => sessionStorage.getItem('tab') || 'grocery');

  // Search state
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [searchPhase, setSearchPhase] = useState('idle');

  // results are split
  const [krogerResults, setKrogerResults] = useState([]);
  const [walmartResults, setWalmartResults] = useState([]);
  const [unmatchedTerms, setUnmatchedTerms] = useState([]);

  // Kroger cart snapshot + optimistic cart
  const [krogerCart, setKrogerCart] = useState({});
  const [optimisticKrogerCart, setOptimisticKrogerCart] = useState({});

  // Agentic UI signals
  const [agenticActiveUpc, setAgenticActiveUpc] = useState(null);
  const [agenticCartProgress, setAgenticCartProgress] = useState({
    active: false,
    total: 0,
    addedCount: 0,
    ok: true,
    skippedCount: 0,
  });
  const [agenticMessage, setAgenticMessage] = useState('');

  // ✅ NEW: fridge photo analysis state
  const [fridgeSessionId, setFridgeSessionId] = useState(null);
  const [fridgeItems, setFridgeItems] = useState([]);

  // ---- Persist/restore last search (for post-OAuth return) ----
  const saveLastSearch = (q, z, budgetSearch = false, autoAdd = false) => {
    sessionStorage.setItem('lastSearchQ', q || '');
    sessionStorage.setItem('lastSearchZ', z || '');
    sessionStorage.setItem('lastSearchBudget', budgetSearch ? '1' : '0');
    sessionStorage.setItem('lastSearchAutoAdd', autoAdd ? '1' : '0');
  };

  const readLastSearch = () => ({
    q: sessionStorage.getItem('lastSearchQ') || '',
    z: sessionStorage.getItem('lastSearchZ') || '',
    budget: sessionStorage.getItem('lastSearchBudget') === '1',
    autoAdd: sessionStorage.getItem('lastSearchAutoAdd') === '1',
  });

  useEffect(() => {
    sessionStorage.setItem('tab', tab);
  }, [tab]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) setIsLoggedIn(true);

    fetchProducts();
    fetchUserData();

    if (token) loadKrogerSnapshot().catch(() => {});

    if (window.location.search.includes('kroger=added')) {
      const { q, z, budget, autoAdd } = readLastSearch();
      if (q) {
        fetchMatchedProductsPhased(q, z || undefined, budget, autoAdd, fridgeSessionId).catch(() => {});
      }
      const url = new URL(window.location.href);
      url.searchParams.delete('kroger');
      window.history.replaceState({}, '', url.toString());
    }
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    getTotalCartValue();
    // eslint-disable-next-line
  }, [cart, products]);

  const authHeaders = () => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const getTotalCartValue = () => {
    if (cart && products.length > 0) {
      const totalValue = Object.entries(cart).reduce((acc, [productId, quantity]) => {
        const product = products.find((p) => p._id === productId);
        if (product) return acc + product.price * quantity;
        return acc;
      }, 0);
      setTotalCartValue(totalValue);
    }
  };

  const fetchProducts = async () => {
    try {
      const response = await axios.get(`${API_BASE}/products`);
      setProducts(response.data);
    } catch (err) {
      console.error('Failed to fetch products:', err.response?.data?.error || err.message);
    }
  };

  // ✅ NEW: Upload fridge photo and get recognized items + sid
  const uploadFridgePhoto = async (file) => {
    if (!file) return null;
    setError('');

    try {
      const form = new FormData();
      form.append('image', file);

      const { data } = await axios.post(`${API_BASE}/kroger/fridge/upload`, form, {
        headers: {
          ...authHeaders(),
          'Content-Type': 'multipart/form-data',
        },
      });

      setFridgeSessionId(data?.fridgeSessionId || null);
      setFridgeItems(Array.isArray(data?.items) ? data.items : []);
      return data;
    } catch (e) {
      console.error(e?.response?.data || e);
      setFridgeSessionId(null);
      setFridgeItems([]);
      setError(e?.response?.data?.error || 'Failed to analyze fridge photo.');
      return null;
    }
  };

  // Start cart add stream after results render
  const startCartAddStream = (cartSessionId) => {
    if (!cartSessionId) return;

    setOptimisticKrogerCart({});
    setAgenticActiveUpc(null);
    setAgenticCartProgress({ active: false, total: 0, addedCount: 0, ok: true, skippedCount: 0 });
    setAgenticMessage('');

    const url = new URL(`${API_BASE}/kroger/cart/add/stream`);
    url.searchParams.set('sid', cartSessionId);

    const token = localStorage.getItem('token');
    if (token) url.searchParams.set('token', token);

    const es = new EventSource(url.toString(), { withCredentials: false });

    es.addEventListener('cart_add_start', (evt) => {
      try {
        const payload = JSON.parse(evt.data || '{}');
        const total = Number(payload?.total || 0);
        const skippedCount = Number(payload?.skippedCount || 0);
        setAgenticCartProgress({ active: true, total, addedCount: 0, ok: true, skippedCount });
      } catch {}
    });

    es.addEventListener('cart_item_skipped', (evt) => {
      try {
        const payload = JSON.parse(evt.data || '{}');
        const skippedCount = Number(payload?.skippedCount || 0);
        setAgenticCartProgress((prev) => ({ ...prev, skippedCount }));
      } catch {}
    });

    es.addEventListener('cart_item_added', (evt) => {
      try {
        const payload = JSON.parse(evt.data || '{}');
        const upc = String(payload?.upc || '').trim();
        const ok = Boolean(payload?.ok);
        const addedCount = Number(payload?.addedCount || 0);
        const total = Number(payload?.total || 0);

        if (upc) setAgenticActiveUpc(upc);

        if (ok && upc) {
          setOptimisticKrogerCart((prev) => {
            const next = { ...prev };
            next[upc] = (Number(next[upc] || 0) || 0) + 1;
            return next;
          });
        }

        setAgenticCartProgress((prev) => ({
          ...prev,
          active: true,
          total: total || prev.total,
          addedCount: addedCount || prev.addedCount,
          ok: prev.ok && ok,
        }));
      } catch {}
    });

    es.addEventListener('cart_add_done', (evt) => {
      try {
        const payload = JSON.parse(evt.data || '{}');
        const ok = Boolean(payload?.ok);
        const addedCount = Number(payload?.addedCount || 0);
        const total = Number(payload?.total || 0);
        const skippedCount = Number(payload?.skippedCount || 0);

        setAgenticCartProgress((prev) => ({
          ...prev,
          active: false,
          total: total || prev.total,
          addedCount: addedCount || prev.addedCount,
          ok: prev.ok && ok,
          skippedCount,
        }));

        const msg =
          `✅ Added ${addedCount}/${total}.` +
          (skippedCount > 0 ? ` Skipped ${skippedCount} (already in fridge).` : '');

        setAgenticMessage(msg);
      } catch {}
    });

    es.addEventListener('need_kroger_auth', (evt) => {
      try {
        const payload = JSON.parse(evt.data || '{}');
        if (payload?.loginUrl) window.location.href = payload.loginUrl;
      } catch {}
    });

    es.addEventListener('done', async () => {
      try {
        await loadKrogerSnapshot().catch(() => {});
      } finally {
        es.close();
      }
    });

    es.addEventListener('error', () => {
      try { es.close(); } catch {}
    });
  };

  // Streaming search (SSE) with fridgeSid pass-through
  const fetchMatchedProductsPhased = (query, zip, budgetSearch = false, autoAdd = false, fridgeSid = null) => {
    saveLastSearch(query, zip, budgetSearch, autoAdd);

    return new Promise((resolve, reject) => {
      setKrogerResults([]);
      setWalmartResults([]);
      setUnmatchedTerms([]);
      setLoadingSearch(true);
      setSearchPhase('finding');
      setError('');

      setOptimisticKrogerCart({});
      setAgenticActiveUpc(null);
      setAgenticCartProgress({ active: false, total: 0, addedCount: 0, ok: true, skippedCount: 0 });
      setAgenticMessage('');

      const url = new URL(`${API_BASE}/kroger/search/stream`);
      url.searchParams.set('query', query);
      if (zip) url.searchParams.set('zip', zip);
      if (budgetSearch) url.searchParams.set('budget', '1');
      if (autoAdd) url.searchParams.set('autoAdd', '1');
      if (fridgeSid) url.searchParams.set('fridgeSid', fridgeSid);

      const token = localStorage.getItem('token');
      if (token) url.searchParams.set('token', token);

      const es = new EventSource(url.toString(), { withCredentials: false });
      let doneReceived = false;

      es.addEventListener('phase', (evt) => {
        try {
          const { phase } = JSON.parse(evt.data || '{}');
          if (phase) setSearchPhase(phase);
        } catch {}
      });

      es.addEventListener('done', (evt) => {
        doneReceived = true;
        let cartSessionId = null;

        try {
          const payload = JSON.parse(evt.data || '{}');

          setKrogerResults(payload?.krogerProducts || []);
          setWalmartResults(payload?.walmartProducts || []);
          setUnmatchedTerms(payload?.unmatchedTerms || []);

          cartSessionId = payload?.cartSessionId || null;

          if (payload?.error) setError(payload.error);
          else setError('');
        } catch (e) {
          console.error('SSE parse error:', e);
          setKrogerResults([]);
          setWalmartResults([]);
          setUnmatchedTerms([]);
          setError('Search failed. Please try again.');
        } finally {
          setLoadingSearch(false);
          setSearchPhase('idle');
          es.close();

          if (autoAdd && cartSessionId) {
            setTimeout(() => startCartAddStream(cartSessionId), 0);
          }
          resolve();
        }
      });

      es.addEventListener('error', (evt) => {
        if (doneReceived || es.readyState === 2) {
          try { es.close(); } catch {}
          return;
        }
        console.error('SSE error:', evt);
        setLoadingSearch(false);
        setSearchPhase('idle');
        setKrogerResults([]);
        setWalmartResults([]);
        setUnmatchedTerms([]);
        setError('Search failed. Please try again.');
        es.close();
        reject(new Error('Search stream failed'));
      });
    });
  };

  // Kroger helpers
  const loadKrogerSnapshot = async () => {
    try {
      const { data } = await axios.get(`${API_BASE}/kroger/cart/snapshot`, {
        headers: authHeaders(),
      });
      setKrogerCart(data?.items || {});
    } catch {}
  };

  const getInCartQty = (upc) => {
    const snap = Number(krogerCart?.[upc] || 0);
    const opt = Number(optimisticKrogerCart?.[upc] || 0);
    return Math.max(snap, opt);
  };

  const addToKrogerCart = async (upc, quantity = 1) => {
    try {
      await axios.post(
        `${API_BASE}/kroger/cart/add`,
        { items: [{ upc, quantity }] },
        { headers: authHeaders() }
      );
      await loadKrogerSnapshot();
      return true;
    } catch (e) {
      const status = e?.response?.status;
      const loginUrl = e?.response?.data?.loginUrl;
      if (status === 401 && loginUrl) {
        window.location.href = loginUrl;
        return false;
      }
      console.error(e?.response?.data || e);
      setError('Could not add item to Kroger cart.');
      return false;
    }
  };

  // Local cart + auth (unchanged from your project)
  const addToCart = (productId) => {
    if (!isLoggedIn) {
      alert('Please login to add products to the cart');
      return;
    }
    const updatedCart = { ...cart, [productId]: (cart[productId] || 0) + 1 };
    const product = products.find((item) => item._id === productId);
    setTotalCartValue((prev) => roundToTwoDecimals(prev + product.price));
    setCart(updatedCart);
    saveCartToBackend(updatedCart);
  };

  const removeFromCart = (productId) => {
    if (!isLoggedIn) {
      alert('Please login to update the cart');
      return;
    }
    if (cart[productId] > 1) {
      const updatedCart = { ...cart, [productId]: cart[productId] - 1 };
      const product = products.find((item) => item._id === productId);
      setTotalCartValue((prev) => roundToTwoDecimals(prev - product.price));
      setCart(updatedCart);
      saveCartToBackend(updatedCart);
    } else {
      removeFromCartList(productId);
    }
  };

  const removeFromCartList = (productId) => {
    if (!isLoggedIn) {
      alert('Please login to update the cart');
      return;
    }
    const updatedCart = { ...cart };
    const product = products.find((item) => item._id === productId);
    setTotalCartValue((prev) => roundToTwoDecimals(prev - product.price * cart[productId]));
    delete updatedCart[productId];
    setCart(updatedCart);
    saveCartToBackend(updatedCart);
  };

  const getTotalCartItems = () =>
    Object.values(cart).reduce((total, quantity) => total + quantity, 0);

  const saveCartToBackend = async (updatedCart) => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      await axios.put(`${API_BASE}/auth/cart`, { cart: updatedCart }, { headers: authHeaders() });
    } catch (err) {
      console.error('Failed to save cart to backend:', err.response?.data?.error || err.message);
    }
  };

  const signup = async (username, email, password) => {
    try {
      const response = await axios.post(`${API_BASE}/auth/signup`, { username, email, password });
      const { token, cart } = response.data;
      localStorage.setItem('token', token);
      setUser({ username, email });
      setCart(cart);
      alert('Signup successful!');
      setIsLoggedIn(true);
      setError('');
    } catch (err) {
      console.error('Signup failed:', err.response?.data?.error || err.message);
      setError(err.response?.data?.error || 'An error occurred');
      setIsLoggedIn(false);
    }
  };

  const login = async (email, password) => {
    try {
      const response = await axios.post(`${API_BASE}/auth/login`, { email, password });
      const { token, username, cart, orders } = response.data;

      localStorage.setItem('token', token);
      alert('Login successful!');
      setUser({ username, email });
      setCart(cart);
      setOrders(orders || []);
      setIsLoggedIn(true);
      setError('');
      setTab('grocery');

      await loadKrogerSnapshot().catch(() => {});
      window.location.href = '/grocery';
    } catch (err) {
      console.error('Login failed:', err.response?.data?.error || err.message);
      setError(err.response?.data?.error || 'Invalid email or password.');
      setIsLoggedIn(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
    setCart({});
    setOrders([]);
    setIsLoggedIn(false);
    setKrogerCart({});
    setOptimisticKrogerCart({});
    setAgenticActiveUpc(null);
    setAgenticCartProgress({ active: false, total: 0, addedCount: 0, ok: true, skippedCount: 0 });
    setAgenticMessage('');
    setFridgeSessionId(null);
    setFridgeItems([]);
    setTab('login');
    window.location.href = '/login';
  };

  const fetchUserData = async () => {
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const response = await axios.get(`${API_BASE}/auth/user`, {
        headers: authHeaders(),
      });

      const { username, email, cart, orders } = response.data;
      setUser({ username, email });
      setCart(cart);
      setOrders(orders || []);
      setIsLoggedIn(true);
    } catch (err) {
      if (err?.response?.status === 401) {
        localStorage.removeItem('token');
        setUser(null);
        setCart({});
        setOrders([]);
        setIsLoggedIn(false);
      }
      console.error('Failed to fetch user data:', err.response?.data?.error || err.message);
    }
  };

  const placeOrder = async () => {
    try {
      const token = localStorage.getItem('token');
      const deliveryFee = Object.values(cart).some((count) => count > 0) ? 4 : 0;
      const total = roundToTwoDecimals(totalCartValue + deliveryFee);

      const response = await axios.post(
        `${API_BASE}/auth/placeOrder`,
        { cart, total },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setCart({});
      setOrders((prev) => [...prev, response.data.order]);
      setTotalCartValue(0);
      window.location.href = '/orders';
    } catch (err) {
      console.error('Failed to place order:', err);
    }
  };

  return (
    <ShopContext.Provider
      value={{
        user,
        isLoggedIn,
        signup,
        login,
        logout,

        cart,
        addToCart,
        removeFromCart,
        removeFromCartList,
        getTotalCartItems,
        saveCartToBackend,
        placeOrder,
        orders,

        products,
        totalCartValue,
        fetchProducts,

        error,
        setError,

        fetchMatchedProductsPhased,
        krogerResults,
        walmartResults,
        unmatchedTerms,
        addToKrogerCart,
        loadingSearch,
        searchPhase,
        getInCartQty,
        loadKrogerSnapshot,

        agenticActiveUpc,
        agenticCartProgress,
        agenticMessage,

        // ✅ NEW
        uploadFridgePhoto,
        fridgeSessionId,
        fridgeItems,
        setFridgeSessionId,
        setFridgeItems,

        tab,
        setTab,
      }}
    >
      {children}
    </ShopContext.Provider>
  );
};

export default ShopProvider;
