import { useContext } from 'react';
import './Navbar.css';
import { Link } from 'react-router-dom';
import { ShopContext } from '../Context/ShopContext';

const Navbar = () => {
  const { user, logout, getTotalCartItems, tab, setTab } = useContext(ShopContext);

  return (
    <div className="navbar">
      <div className="nav_logo">
        <h1>XYZ</h1>
      </div>
      <ul className="nav_menu">
        <li onClick={() => { setTab("grocery") }}><Link style={{ textDecoration: 'none' }} to='/grocery'>Grocery</Link> {tab === "grocery" ? <hr /> : <></>}</li>
        <li onClick={() => { setTab("meat") }}><Link style={{ textDecoration: 'none' }} to='/meat'>Meat & Fish</Link> {tab === "meat" ? <hr /> : <></>}</li>
        <li onClick={() => { setTab("dairy") }}><Link style={{ textDecoration: 'none' }} to='/dairy'>Dairy & Sweets</Link> {tab === "dairy" ? <hr /> : <></>}</li>
        <li onClick={() => { setTab("household") }}><Link style={{ textDecoration: 'none' }} to='/household'>Household Essentials</Link> {tab === "household" ? <hr /> : <></>}</li>
        <li onClick={() => { setTab("orders") }}><Link style={{ textDecoration: 'none' }} to='/orders'>Orders</Link> {tab === "orders" ? <hr /> : <></>}</li>
        <li onClick={() => { setTab("search") }}><Link to="/search">🔍</Link></li>
      </ul>
      <div className="nav_login">
        {user ? (
          <>
            <span>Welcome, {user.username}</span>
            <button onClick={() => {
              logout();
              setTab("login");
            }}>Logout</button>
          </>
        ) : (
          <button onClick={() => { setTab("login") }}><Link style={{ textDecoration: 'none' }} to='/login'>Login</Link> {tab === "login" ? <hr /> : <></>}</button>
        )}
      </div>
      <div className="nav_cart">
        <h2 onClick={() => { setTab("cart") }}><Link style={{ textDecoration: 'none' }} to='/cart'>Cart</Link> {tab === "cart" ? <hr /> : <></>}</h2>
        <div className="nav_cart_count">{getTotalCartItems()}</div>
      </div>
    </div>
  );
};

export default Navbar;
