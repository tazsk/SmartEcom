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
  const [searchPhase, setSearchPhase] = useState('idle'); // 'idle' | 'finding' | 'fetching' | 'matching'

  // NEW: results are now split
  const [krogerResults, setKrogerResults] = useState([]);
  const [walmartResults, setWalmartResults] = useState([]);
  const [unmatchedTerms, setUnmatchedTerms] = useState([]);

  // NEW: light snapshot of Kroger cart (for “In Cart X” badges)
  const [krogerCart, setKrogerCart] = useState({}); // { [upc]: qty }

  // ---- Persist/restore last search (for post-OAuth return) ----
  const saveLastSearch = (q, z) => {
    sessionStorage.setItem('lastSearchQ', q || '');
    sessionStorage.setItem('lastSearchZ', z || '');
  };
  const readLastSearch = () => ({
    q: sessionStorage.getItem('lastSearchQ') || '',
    z: sessionStorage.getItem('lastSearchZ') || '',
  });

  // ---- Effects ----
  useEffect(() => {
    sessionStorage.setItem('tab', tab);
  }, [tab]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) setIsLoggedIn(true);
    fetchProducts();
    fetchUserData();
    if (token) loadKrogerSnapshot().catch(() => {});

    // If we just returned from Kroger (kroger=added), re-run the last search
    if (window.location.search.includes('kroger=added')) {
      const { q, z } = readLastSearch();
      if (q) {
        fetchMatchedProductsPhased(q, z || undefined).catch(() => {});
      }
      const url = new URL(window.location.href);
      url.searchParams.delete('kroger');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  useEffect(() => {
    getTotalCartValue();
    // eslint-disable-next-line
  }, [cart, products]);

  // ---- Helpers ----
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

  // ---------- Existing non-streaming API (kept as a fallback) ----------
  const fetchMatchedProducts = async (query, zip) => {
    setLoadingSearch(true);
    setSearchPhase('finding');
    setError('');
    try {
      const { data } = await axios.post(`${API_BASE}/kroger/search`, { query, zip }, { headers: authHeaders() });
      setKrogerResults(data?.krogerProducts || []);
      setWalmartResults(data?.walmartProducts || []);
      setUnmatchedTerms(data?.unmatchedTerms || []);
      saveLastSearch(query, zip);
    } catch (err) {
      console.error('Error fetching matched products:', err?.response?.data || err.message);
      setKrogerResults([]);
      setWalmartResults([]);
      setUnmatchedTerms([]);
      setError('Search failed. Please try again.');
    } finally {
      setLoadingSearch(false);
      setSearchPhase('idle');
    }
  };

  // ---------- Streaming (SSE) version with phases ----------
  const fetchMatchedProductsPhased = (query, zip) => {
    saveLastSearch(query, zip);
    return new Promise((resolve, reject) => {
      setKrogerResults([]);
      setWalmartResults([]);
      setUnmatchedTerms([]);
      setLoadingSearch(true);
      setSearchPhase('finding');
      setError('');

      const url = new URL(`${API_BASE}/kroger/search/stream`);
      url.searchParams.set('query', query);
      if (zip) url.searchParams.set('zip', zip);

      const es = new EventSource(url.toString(), { withCredentials: false });

      es.addEventListener('phase', (evt) => {
        try {
          const { phase } = JSON.parse(evt.data || '{}');
          if (phase) setSearchPhase(phase);
        } catch {}
      });

      es.addEventListener('done', (evt) => {
        try {
          const payload = JSON.parse(evt.data || '{}');
          setKrogerResults(payload?.krogerProducts || []);
          setWalmartResults(payload?.walmartProducts || []);
          setUnmatchedTerms(payload?.unmatchedTerms || []);
          if (payload.error) setError(payload.error);
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
          resolve();
        }
      });

      es.addEventListener('error', (evt) => {
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

  // ---------- Kroger helpers ----------
  const loadKrogerSnapshot = async () => {
    try {
      const { data } = await axios.get(`${API_BASE}/kroger/cart/snapshot`, {
        headers: authHeaders(),
      });
      setKrogerCart(data?.items || {});
    } catch (e) {
      // silent fail (user may not be linked yet)
    }
  };

  const getInCartQty = (upc) => Number(krogerCart?.[upc] || 0);

  const addToKrogerCart = async (upc, quantity = 1) => {
    try {
      await axios.post(
        `${API_BASE}/kroger/cart/add`,
        { items: [{ upc, quantity }] }, // negative quantity works for decrements
        { headers: authHeaders() }
      );
      await loadKrogerSnapshot(); // refresh local snapshot so other searches show counts
      return true;
    } catch (e) {
      const status = e?.response?.status;
      const loginUrl = e?.response?.data?.loginUrl;
      if (status === 401 && loginUrl) {
        window.location.href = loginUrl; // go through Kroger consent
        return false;
      }
      console.error(e?.response?.data || e);
      setError('Could not add item to Kroger cart.');
      return false;
    }
  };

  // ---------- Local cart (unchanged) ----------
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
      setTab('grocery');
      await loadKrogerSnapshot().catch(() => {});
      window.location.href = 'grocery';
    } catch (err) {
      console.error('Login failed:', err.response?.data?.error || err.message);
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
    setTab('login');
    window.location.href = 'login';
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
        // auth
        user,
        isLoggedIn,
        signup,
        login,
        logout,

        // cart & orders
        cart,
        addToCart,
        removeFromCart,
        removeFromCartList,
        getTotalCartItems,
        saveCartToBackend,
        placeOrder,
        orders,

        // catalog
        products,
        totalCartValue,
        fetchProducts,

        // errors
        error,
        setError,

        // Kroger search (+ Walmart fallback)
        fetchMatchedProducts,          // fallback (non-streaming)
        fetchMatchedProductsPhased,    // streaming with phases
        krogerResults,
        walmartResults,
        unmatchedTerms,
        addToKrogerCart,
        loadingSearch,
        searchPhase,
        getInCartQty,
        loadKrogerSnapshot,

        // UI state
        tab,
        setTab,
      }}
    >
      {children}
    </ShopContext.Provider>
  );
};

export default ShopProvider;
