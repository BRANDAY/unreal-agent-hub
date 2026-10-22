import '@mantine/core/styles.layer.css';
import '@mantine/charts/styles.layer.css';
import 'mantine-datatable/styles.layer.css';
import './app.css';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import App from './App.jsx';

const theme = createTheme({
  primaryColor: 'indigo',
  defaultRadius: 'md',
  fontFamily: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
  headings: { fontFamily: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif' },
});

createRoot(document.getElementById('root')).render(
  <MantineProvider theme={theme} defaultColorScheme="auto">
    <App />
  </MantineProvider>,
);
