import { Link, Route, Routes } from 'react-router-dom';
import { RedirectIfAuthed, RequireAuth } from './auth/RequireAuth';
import Layout from './components/Layout';
import { btn } from './components/ui';
import AgentDetailPage from './pages/AgentDetailPage';
import AgentsPage from './pages/AgentsPage';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import DashboardPage from './pages/DashboardPage';
import LeaguePage from './pages/LeaguePage';
import LeaguesPage from './pages/LeaguesPage';
import TradePage from './pages/TradePage';

function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <h1 className="text-2xl font-bold">페이지를 찾을 수 없습니다</h1>
      <Link to="/" className={btn.primary}>
        대시보드로 이동
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <LoginPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/register"
        element={
          <RedirectIfAuthed>
            <RegisterPage />
          </RedirectIfAuthed>
        }
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="leagues" element={<LeaguesPage />} />
        <Route path="leagues/:id" element={<LeaguePage />} />
        <Route path="leagues/:id/trade" element={<TradePage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:id" element={<AgentDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
