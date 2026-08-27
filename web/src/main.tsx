import { createRoot } from 'react-dom/client'
import App from './app/App'
import { useStore } from './app/store'
import './ui/theme.css'

useStore.getState().boot()

createRoot(document.getElementById('root')!).render(<App />)
