import './App.css';
import Navbar from './Components/Navbar/Navbar';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Cart } from './Components/Pages/Cart'
import { LoginSignup } from './Components/Pages/LoginSignup'
import { Product } from './Components/Pages/Product'
import { ShopCategory } from './Components/Pages/ShopCategory'
import Orders from './Components/Pages/Orders';
import { useContext } from 'react';
import { ShopContext } from './Components/Context/ShopContext';
import SearchResults from './Components/Pages/SearchResults';

function App() {
  
  const { tab } = useContext(ShopContext);

  return (
    <div className="App">
      <BrowserRouter>
        <Navbar/>
        <Routes>
          <Route path="/" element={<Navigate to={`/${tab}`} />} />
          <Route path='/grocery' element={<ShopCategory category="grocery"/>}/>
          <Route path='/meat' element={<ShopCategory category="meat"/>}/>
          <Route path='/dairy' element={<ShopCategory category="dairy"/>}/>
          <Route path='/household' element={<ShopCategory category="household"/>}/>
          <Route path='/search' element={<SearchResults />} />
          <Route path='/orders' element={<Orders/>}/>
          <Route path='/product' element={<Product/>}>
            <Route path=':productId' element={<Product/>}/>
          </Route>
          <Route path='/cart' element={<Cart/>}/>
          <Route path='/login' element={<LoginSignup/>}/>
        </Routes>
      </BrowserRouter>
      
    </div>
  );
}

export default App;
