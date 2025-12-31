import React, { useContext, useState } from 'react'
import { ShopContext } from '../Context/ShopContext'
import Modal from 'react-modal';
import './CartItems.css'

Modal.setAppElement('#root');

const roundToTwoDecimals = (value) => Math.round(value * 100) / 100;

const CartItems = () => {

  const [showModal, setShowModal] = useState(false);

  const {products, cart, addToCart, removeFromCart, removeFromCartList, totalCartValue, placeOrder, isLoggedIn, setTab } = useContext(ShopContext)

  const deliveryFee = Object.values(cart).some((count) => count > 0) ? 4 : 0;

  const handlePlaceOrder = async () => {
    await placeOrder();
    setTab("orders");
    setShowModal(false);
  };


  return isLoggedIn ? (
    <div className='cartitems'>
        <div className='cartitems-format-main'>
            <p><b>Products</b></p>
            <p><b>Title</b></p>
            <p><b>Price</b></p>
            <p><b>Quantity</b></p>
            <p><b>Total</b></p>
            <p><b>Remove</b></p>
        </div>
        <hr/>
        {products.map((e) => {
            if(cart[e._id] > 0) {
                return (
                        <div>
                            <div className='cartitems-format-main'>
                                <img className='image' src={e.imageUrl} alt=""></img>
                                <p>{e.title}</p>
                                <p>{`$${e.price}`}</p>
                                <div className='div_quantity'>
                                    <button className='minus_btn' type='button' onClick={() => {removeFromCart(e._id)}}>➖</button>
                                    <p className='quantity'>{`${cart[e._id]}`}</p>
                                    <button className='plus_btn' type='button' onClick={() => {addToCart(e._id)}}>➕</button>
                                </div>
                                <p>{`$${roundToTwoDecimals(e.price * cart[e._id])}`}</p>
                                <button className='remove' onClick={() => {removeFromCartList(e._id)}}>❌</button>
                            </div>
                        </div>
                    )
            }
            return null;
        })}
        <div className='cartitems_footer'>
            <div>
                <h1>Cart Total</h1>
                <div className='subtotal_delivery_total'>
                    <p>Subtotal</p>
                    <p>${roundToTwoDecimals(totalCartValue)}</p>
                </div>
                <hr/>
                <div className='subtotal_delivery_total'>
                    <p>Delivery Fee</p>
                    <p>${deliveryFee}</p>
                </div>
                <hr/>
                <div className='subtotal_delivery_total'>
                    <h3>Total</h3>
                    <h3>${roundToTwoDecimals(totalCartValue + deliveryFee)}</h3>
                </div>
            </div>
            {Object.keys(cart).length > 0 ? (<button onClick={() => setShowModal(true)}>Proceed to Checkout</button>) : null}
        </div>

        <Modal
        isOpen={showModal}
        onRequestClose={() => setShowModal(false)}
        contentLabel="Checkout Modal"
        className="modal"
        overlayClassName="overlay"
        >
        <h2>Checkout</h2>
        <div className="modal-body">
           {Object.entries(cart).map(([productId, quantity]) => {
             const product = products.find((p) => p._id === productId);
             return (
               <div key={productId} className="modal-item">
                 <img className="modal-image" src={product.imageUrl} alt={product.title} />
                 <p>{product.title}</p><hr/>
                 <p>Quantity: {quantity}</p><hr/>
                 <p>Total: ${product.price * quantity}</p>
               </div>
             );
           })}
           <hr />
           <p>Subtotal: ${roundToTwoDecimals(totalCartValue)}</p>
           <p>Delivery Fee: ${deliveryFee}</p>
           <h3>Total: ${roundToTwoDecimals(totalCartValue + deliveryFee)}</h3>
         </div>
        Are you sure you want to place the above order?<br/>
        <button onClick={() => handlePlaceOrder()}>Place Order</button>
        <button onClick={() => setShowModal(false)}>Cancel</button>
      </Modal>
    </div>) : (<div>
      <h2>Oh no! Your cart looks empty 😔</h2>
      <h2><a href='/login'>Sign In</a> to start shopping...</h2>
    </div>)}

export default CartItems;