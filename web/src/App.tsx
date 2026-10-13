import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { api, type ReviewRow } from './api';
import BaseUrlBar from './components/BaseUrlBar';
import Flows from './pages/Flows';
import FlowDetail from './pages/FlowDetail';
import Upload from './pages/Upload';
import Reviews from './pages/Reviews';
import Steps from './pages/Steps';
import Runs from './pages/Runs';
import RunDetail from './pages/RunDetail';

function Header() {
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    api<ReviewRow[]>('/reviews?status=pending')
      .then(r => setPending(r.length))
      .catch(() => setPending(null));
  }, []);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <nav className="nav">
          <NavLink to="/" end>Flows</NavLink>
          <NavLink to="/upload">Upload</NavLink>
          <NavLink to="/reviews">
            Reviews{pending ? <span className="count">{pending}</span> : null}
          </NavLink>
          <NavLink to="/steps">Steps</NavLink>
          <NavLink to="/runs">Runs</NavLink>
        </nav>
        <BaseUrlBar />
      </div>
    </header>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Header />
      <main className="container">
        <Routes>
          <Route path="/" element={<Flows />} />
          <Route path="/flows/:id" element={<FlowDetail />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/steps" element={<Steps />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
