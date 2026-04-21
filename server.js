import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT;
const VTEX_APP_KEY = process.env.VTEX_APP_KEY;
const VTEX_APP_TOKEN = process.env.VTEX_APP_TOKEN;
const BASE_URL = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;

const vtexHeaders = {
  'X-VTEX-API-AppKey': VTEX_APP_KEY,
  'X-VTEX-API-AppToken': VTEX_APP_TOKEN,
  'Content-Type': 'application/json',
};

async function vtexGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: vtexHeaders });
  if (!res.ok) throw new Error(`VTEX ${res.status}: ${await res.text()}`);
  return res.json();
}

const TOOLS = [
  {
    name: 'get_orders',
    description: 'Obtiene las últimas órdenes de la tienda VTEX con filtros opcionales de fecha y estado',
    inputSchema: {
      type: 'object',
      properties: {
        from:     { type: 'string', description: 'Fecha inicio YYYY-MM-DD (default: hace 7 días)' },
        to:       { type: 'string', description: 'Fecha fin YYYY-MM-DD (default: hoy)' },
        status:   { type: 'string', description: 'Estado: invoiced, payment-approved, canceled, handling' },
        per_page: { type: 'number', description: 'Cantidad de órdenes (max 100, default 50)' },
      }
    }
  },
  {
    name: 'get_order_detail',
    description: 'Obtiene el detalle completo de una orden específica por ID',
    inputSchema: {
      type: 'object',
      required: ['orderId'],
      properties: {
        orderId: { type: 'string', description: 'ID de la orden ej: SRK-123456789' }
      }
    }
  },
  {
    name: 'get_products',
    description: 'Obtiene productos del catálogo VTEX',
    inputSchema: {
      type: 'object',
      properties: {
        from:       { type: 'number', description: 'Índice inicio (default: 0)' },
        to:         { type: 'number', description: 'Índice fin (default: 49)' },
        categoryId: { type: 'string', description: 'ID de categoría para filtrar' },
      }
    }
  },
  {
    name: 'get_inventory',
    description: 'Obtiene el inventario/stock de un SKU específico',
    inputSchema: {
      type: 'object',
      required: ['skuId'],
      properties: {
        skuId: { type: 'string', description: 'ID del SKU' }
      }
    }
  },
  {
    name: 'get_sales_summary',
    description: 'Resumen de ventas: total facturado, ticket promedio, órdenes por estado en un período',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Fecha inicio YYYY-MM-DD' },
        to:   { type: 'string', description: 'Fecha fin YYYY-MM-DD' },
      }
    }
  },
];

async function callTool(name, input = {}) {
  if (name === 'get_orders') {
    const to   = input.to   || new Date().toISOString().split('T')[0];
    const from = input.from || new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    const per  = Math.min(input.per_page || 50, 100);
    let path = `/api/oms/pvt/orders?orderBy=creationDate,desc&per_page=${per}&f_creationDate=creationDate:[${from}T00:00:00.000Z TO ${to}T23:59:59.999Z]`;
    if (input.status) path += `&f_status=${input.status}`;
    const data = await vtexGet(path);
    return {
      total: data.paging?.total,
      pages: data.paging?.pages,
      orders: (data.list || []).map(o => ({
        orderId:      o.orderId,
        status:       o.status,
        value:        (o.value || 0) / 100,
        creationDate: o.creationDate,
        customer:     `${o.clientProfileData?.firstName || ''} ${o.clientProfileData?.lastName || ''}`.trim(),
        email:        o.clientProfileData?.email,
        items:        o.items?.length || 0,
      }))
    };
  }

  if (name === 'get_order_detail') {
    const data = await vtexGet(`/api/oms/pvt/orders/${input.orderId}`);
    return {
      orderId:      data.orderId,
      status:       data.status,
      value:        (data.value || 0) / 100,
      creationDate: data.creationDate,
      customer:     data.clientProfileData,
      items:        data.items?.map(i => ({ name: i.name, quantity: i.quantity, price: (i.price||0)/100 })),
      shipping:     data.shippingData?.address,
      payment:      data.paymentData?.transactions?.[0]?.payments?.[0]?.paymentSystemName,
    };
  }

  if (name === 'get_products') {
    const from = input.from || 0;
    const to   = input.to   || 49;
    const cat  = input.categoryId ? `&categoryId=${input.categoryId}` : '';
    return await vtexGet(`/api/catalog_system/pvt/products/GetProductAndSkuIds?_from=${from}&_to=${to}${cat}`);
  }

  if (name === 'get_inventory') {
    return await vtexGet(`/api/logistics/pvt/inventory/skus/${input.skuId}`);
  }

  if (name === 'get_sales_summary') {
    const to   = input.to   || new Date().toISOString().split('T')[0];
    const from = input.from || new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    const data = await vtexGet(`/api/oms/pvt/orders?orderBy=creationDate,desc&per_page=100&f_creationDate=creationDate:[${from}T00:00:00.000Z TO ${to}T23:59:59.999Z]`);
    const orders = data.list || [];
    const total  = orders.reduce((s, o) => s + (o.value||0)/100, 0);
    const byStatus = {};
    orders.forEach(o => { byStatus[o.status] = (byStatus[o.status]||0)+1; });
    return {
      period:        { from, to },
      totalOrders:   data.paging?.total,
      sampledOrders: orders.length,
      totalRevenue:  Math.round(total * 100) / 100,
      avgTicket:     orders.length ? Math.round(total/orders.length*100)/100 : 0,
      byStatus,
    };
  }

  throw new Error(`Tool desconocida: ${name}`);
}

// ── MCP SSE endpoint (GET /mcp) ────────────────────────────────
app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`event: endpoint\ndata: /mcp\n\n`);

  req.on('close', () => res.end());
});

// ── MCP JSON-RPC endpoint (POST /mcp) ─────────────────────────
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  try {
    let result;

    if (method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vtex-mcp', version: '1.0.0' },
      };
    }

    else if (method === 'notifications/initialized') {
      return res.status(204).end();
    }

    else if (method === 'tools/list') {
      result = { tools: TOOLS };
    }

    else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const toolResult = await callTool(name, args || {});
      result = {
        content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }]
      };
    }

    else {
      return res.json({
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    }

    return res.json({ jsonrpc: '2.0', id, result });

  } catch (err) {
    return res.json({
      jsonrpc: '2.0', id,
      error: { code: -32603, message: err.message }
    });
  }
});

// ── Health check ───────────────────────────────────────────────
app.get('/api/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.json({ status: 'ok', server: 'vtex-mcp', account: VTEX_ACCOUNT }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VTEX MCP Server corriendo en puerto ${PORT}`));
