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

// ── BIN lookup via binlist.net con cache en memoria ───────────
const binCache = new Map();

async function resolveBank(bin) {
  if (!bin) return { bank: null, brand: null, country: null, type: null };
  const str = String(bin).replace(/\s/g, '').slice(0, 6);
  if (binCache.has(str)) return binCache.get(str);
  try {
    const res = await fetch(`https://lookup.binlist.net/${str}`, {
      headers: { 'Accept-Version': '3' }
    });
    if (!res.ok) throw new Error(`binlist ${res.status}`);
    const data = await res.json();
    const result = {
      bank:    data.bank?.name    || null,
      brand:   data.scheme        ? data.scheme.charAt(0).toUpperCase() + data.scheme.slice(1) : null,
      country: data.country?.name || null,
      type:    data.type          || null,
    };
    binCache.set(str, result);
    return result;
  } catch {
    const fallback = { bank: 'Desconocido', brand: null, country: null, type: null };
    binCache.set(str, fallback);
    return fallback;
  }
}

const TOOLS = [
  {
    name: 'get_orders',
    description: 'Obtiene órdenes de VTEX con paginación. Puede traer hasta max_orders órdenes iterando páginas automáticamente.',
    inputSchema: {
      type: 'object',
      properties: {
        from:       { type: 'string', description: 'Fecha inicio YYYY-MM-DD (default: hace 7 días)' },
        to:         { type: 'string', description: 'Fecha fin YYYY-MM-DD (default: hoy)' },
        status:     { type: 'string', description: 'Estado: invoiced, payment-approved, canceled, handling' },
        max_orders: { type: 'number', description: 'Máximo de órdenes a traer (default: 100, max: 1000). Pagina automáticamente.' },
        page:       { type: 'number', description: 'Página específica a traer (default: 1). Usar junto con per_page para paginación manual.' },
        per_page:   { type: 'number', description: 'Órdenes por página (max 100, default 100). Solo aplica si no se usa max_orders.' },
      }
    }
  },
  {
    name: 'get_order_detail',
    description: 'Obtiene el detalle completo de una orden específica por ID, incluyendo datos de pago, rule name de promoción bancaria y condición de pago',
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
  {
    name: 'get_top_products',
    description: 'Productos más vendidos en un período, ordenados por cantidad vendida o revenue',
    inputSchema: {
      type: 'object',
      properties: {
        from:      { type: 'string', description: 'Fecha inicio YYYY-MM-DD (default: hace 30 días)' },
        to:        { type: 'string', description: 'Fecha fin YYYY-MM-DD (default: hoy)' },
        limit:     { type: 'number', description: 'Top N productos (default: 20, max: 100)' },
        max_orders:{ type: 'number', description: 'Órdenes a analizar (default: 500, max: 1000)' },
      }
    }
  },
  {
    name: 'get_customers',
    description: 'Lista clientes con historial de compras. Permite buscar por email o ver los más recientes.',
    inputSchema: {
      type: 'object',
      properties: {
        email:     { type: 'string', description: 'Email exacto del cliente a buscar' },
        from:      { type: 'string', description: 'Fecha inicio YYYY-MM-DD (default: hace 30 días)' },
        to:        { type: 'string', description: 'Fecha fin YYYY-MM-DD (default: hoy)' },
        max_orders:{ type: 'number', description: 'Órdenes a analizar (default: 200, max: 500)' },
      }
    }
  },
  {
    name: 'get_bank_summary',
    description: 'Analiza bancos emisores, marcas de tarjeta, cuotas y medios de pago en un período. Resuelve el banco real desde el BIN via binlist.net. Ideal para gráficos de distribución de pagos.',
    inputSchema: {
      type: 'object',
      properties: {
        from:       { type: 'string', description: 'Fecha inicio YYYY-MM-DD (default: hace 7 días)' },
        to:         { type: 'string', description: 'Fecha fin YYYY-MM-DD (default: hoy)' },
        max_orders: { type: 'number', description: 'Máximo de órdenes a analizar (default: 200, max: 500)' },
      }
    }
  },
];

async function callTool(name, input = {}) {
  if (name === 'get_orders') {
    const to         = input.to   || new Date().toISOString().split('T')[0];
    const from       = input.from || new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    const maxOrders  = Math.min(input.max_orders || 100, 1000);
    const pageSize   = 100;
    const statusFilter = input.status ? `&f_status=${input.status}` : '';
    const dateFilter   = `f_creationDate=creationDate:[${from}T00:00:00.000Z TO ${to}T23:59:59.999Z]`;

    // Modo paginación manual: solo trae una página específica
    if (input.page) {
      const per = Math.min(input.per_page || 50, 100);
      const data = await vtexGet(
        `/api/oms/pvt/orders?orderBy=creationDate,desc&per_page=${per}&page=${input.page}&${dateFilter}${statusFilter}`
      );
      return {
        total:       data.paging?.total,
        pages:       data.paging?.pages,
        currentPage: input.page,
        perPage:     per,
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

    // Modo automático: pagina hasta traer maxOrders órdenes
    let allOrders = [];
    let currentPage = 1;
    let totalInVtex = null;

    while (allOrders.length < maxOrders) {
      const remaining = maxOrders - allOrders.length;
      const limit     = Math.min(pageSize, remaining);
      const data      = await vtexGet(
        `/api/oms/pvt/orders?orderBy=creationDate,desc&per_page=${limit}&page=${currentPage}&${dateFilter}${statusFilter}`
      );

      const list = data.list || [];
      if (totalInVtex === null) totalInVtex = data.paging?.total || 0;

      allOrders = allOrders.concat(list);

      // Parar si ya no hay más páginas o llegamos al total real
      if (list.length < limit || allOrders.length >= totalInVtex) break;
      currentPage++;

      // Pausa entre páginas para no saturar la API
      if (allOrders.length < maxOrders) await new Promise(r => setTimeout(r, 200));
    }

    // Enriquecer con detalle individual (la API de listado no devuelve value ni clientProfileData)
    const enriched = [];
    for (let i = 0; i < allOrders.length; i += 10) {
      const batch = allOrders.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(o => vtexGet(`/api/oms/pvt/orders/${o.orderId}`))
      );
      results.forEach((r, idx) => {
        const base = batch[idx];
        const d    = r.status === 'fulfilled' ? r.value : null;
        enriched.push({
          orderId:      base.orderId,
          status:       base.status,
          value:        d ? (d.value || 0) / 100 : 0,
          creationDate: base.creationDate,
          customer:     d ? `${d.clientProfileData?.firstName || ''} ${d.clientProfileData?.lastName || ''}`.trim() : '',
          email:        d?.clientProfileData?.email || '',
          items:        d?.items?.length || 0,
        });
      });
      if (i + 10 < allOrders.length) await new Promise(r => setTimeout(r, 200));
    }

    const totalRevenue = enriched.reduce((s, o) => s + o.value, 0);

    return {
      total:      totalInVtex,
      fetched:    enriched.length,
      hasMore:    enriched.length < totalInVtex,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      avgTicket:  enriched.length ? Math.round(totalRevenue / enriched.length * 100) / 100 : 0,
      orders:     enriched,
    };
  }

  if (name === 'get_order_detail') {
    const data = await vtexGet(`/api/oms/pvt/orders/${input.orderId}`);

    // Extraer todos los pagos de todas las transacciones
    const transactions = data.paymentData?.transactions || [];
    const payments = await Promise.all(
      transactions.flatMap(t =>
        (t.payments || []).map(async p => {
          const bin = p.firstDigits || null;
          const { bank, brand, country, type } = await resolveBank(bin);
          return {
            paymentSystemName: p.paymentSystemName,
            paymentSystem:     p.paymentSystem,
            ruleName:          p.ruleName || null,
            value:             (p.value || 0) / 100,
            installments:      p.installments || 1,
            firstDigits:       bin,
            lastDigits:        p.lastDigits || null,
            bank,
            brand,
            country,
            type,
            tid:               t.tid || null,
            transactionId:     t.transactionId || null,
            lastChange:        t.lastChange || null,
          };
        })
      )
    );

    return {
      orderId:      data.orderId,
      status:       data.status,
      value:        (data.value || 0) / 100,
      creationDate: data.creationDate,
      lastChange:   data.lastChange,
      customer:     data.clientProfileData,
      items:        data.items?.map(i => ({
        name:     i.name,
        quantity: i.quantity,
        price:    (i.price || 0) / 100,
        skuId:    i.id,
      })),
      shipping:     data.shippingData?.address,
      // Resumen rápido del primer pago (retrocompatibilidad)
      payment: {
        paymentSystemName: payments[0]?.paymentSystemName || null,
        ruleName:          payments[0]?.ruleName || null,
        paymentSystem:     payments[0]?.paymentSystem || null,
        tid:               payments[0]?.tid || null,
        value:             payments[0]?.value || 0,
        installments:      payments[0]?.installments || 1,
        firstDigits:       payments[0]?.firstDigits || null,
        lastDigits:        payments[0]?.lastDigits || null,
        bank:              payments[0]?.bank || null,
        brand:             payments[0]?.brand || null,
      },
      // Lista completa de pagos
      allPayments: payments,
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
    const dateFilter = `f_creationDate=creationDate:[${from}T00:00:00.000Z TO ${to}T23:59:59.999Z]`;

    // VTEX limita a 30 páginas (3000 órdenes). Traemos hasta ese máximo.
    const MAX_PAGES = 30;
    let allOrders = [];
    let currentPage = 1;
    let totalInVtex = null;

    while (currentPage <= MAX_PAGES) {
      const data = await vtexGet(
        `/api/oms/pvt/orders?orderBy=creationDate,desc&per_page=100&page=${currentPage}&${dateFilter}`
      );
      const list = data.list || [];
      if (totalInVtex === null) totalInVtex = data.paging?.total || 0;
      allOrders = allOrders.concat(list);
      if (list.length < 100 || allOrders.length >= totalInVtex) break;
      currentPage++;
      await new Promise(r => setTimeout(r, 200));
    }

    // Enriquecer con detalle individual para obtener value real (el listado lo devuelve en 0)
    // Muestra de hasta 200 órdenes para estimar ticket promedio sin timeout
    const SAMPLE_SIZE = 200;
    const sampleOrders = allOrders.slice(0, SAMPLE_SIZE);
    const details = [];
    for (let i = 0; i < sampleOrders.length; i += 10) {
      const batch = sampleOrders.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(o => vtexGet(`/api/oms/pvt/orders/${o.orderId}`))
      );
      results.forEach(r => { if (r.status === 'fulfilled') details.push(r.value); });
      if (i + 10 < sampleOrders.length) await new Promise(r => setTimeout(r, 150));
    }

    const byStatus = {};
    allOrders.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });

    // Calcular ticket promedio solo sobre órdenes con valor > 0 (excluye regalos/gratuitas)
    const paidDetails = details.filter(o => (o.value || 0) > 0);
    const sampleRevenue = paidDetails.reduce((s, o) => s + (o.value || 0) / 100, 0);
    const avgTicket = paidDetails.length ? Math.round(sampleRevenue / paidDetails.length * 100) / 100 : 0;

    // Extrapolar revenue total usando el ticket promedio de la muestra
    const invoicedTotal = byStatus['invoiced'] || 0;
    const estimatedRevenue = Math.round(avgTicket * invoicedTotal * 100) / 100;

    return {
      period:            { from, to },
      totalOrders:       totalInVtex,
      sampledOrders:     details.length,
      avgTicket,
      estimatedRevenue,
      note:              totalInVtex > allOrders.length
        ? `VTEX limita a 30 páginas. Se analizaron ${details.length} órdenes de muestra para estimar el ticket. Revenue estimado sobre ${invoicedTotal} órdenes facturadas.`
        : `Revenue calculado sobre muestra de ${details.length} órdenes.`,
      byStatus,
    };
  }

  if (name === 'get_bank_summary') {
    const to   = input.to   || new Date().toISOString().split('T')[0];
    const from = input.from || new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    const maxOrders = Math.min(input.max_orders || 200, 500);

    // Traer todas las páginas de órdenes hasta maxOrders
    const pageSize = 100;
    const pages = Math.ceil(maxOrders / pageSize);
    let allOrders = [];
    for (let p = 0; p < pages; p++) {
      const offset = p * pageSize;
      const limit  = Math.min(pageSize, maxOrders - offset);
      const data   = await vtexGet(
        `/api/oms/pvt/orders?orderBy=creationDate,desc&per_page=${limit}&page=${p+1}&f_creationDate=creationDate:[${from}T00:00:00.000Z TO ${to}T23:59:59.999Z]`
      );
      allOrders = allOrders.concat(data.list || []);
      if (allOrders.length >= (data.paging?.total || 0)) break;
    }

    // Traer detalles en paralelo por lotes de 10 para no saturar la API
    const details = [];
    const batchSize = 10;
    for (let i = 0; i < allOrders.length; i += batchSize) {
      const batch = allOrders.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(o => vtexGet(`/api/oms/pvt/orders/${o.orderId}`))
      );
      results.forEach(r => { if (r.status === 'fulfilled') details.push(r.value); });
      // Pequeña pausa entre lotes para respetar rate limits
      if (i + batchSize < allOrders.length) await new Promise(r => setTimeout(r, 300));
    }

    // Extraer BINs únicos y resolverlos todos (con cache, evita duplicados)
    const uniqueBins = [...new Set(
      details.flatMap(d => (d.paymentData?.transactions || [])
        .flatMap(t => (t.payments || []).map(p => p.firstDigits).filter(Boolean))
      )
    )];

    // Resolver todos los BINs únicos (con pausa para respetar rate limit de binlist: ~10/min)
    for (let i = 0; i < uniqueBins.length; i++) {
      await resolveBank(uniqueBins[i]);
      if ((i + 1) % 8 === 0) await new Promise(r => setTimeout(r, 6000)); // pausa cada 8 BINs
    }

    // Acumular estadísticas
    const byBank      = {};
    const byBrand     = {};
    const byMethod    = {};
    const byInstall   = {};
    const byBankBrand = {};
    let totalRevenue  = 0;
    let ordersWithBin = 0;
    let ordersNoBin   = 0;

    for (const d of details) {
      const value = (d.value || 0) / 100;
      totalRevenue += value;
      const transactions = d.paymentData?.transactions || [];
      for (const t of transactions) {
        for (const p of (t.payments || [])) {
          const method = p.paymentSystemName || 'Desconocido';
          byMethod[method] = (byMethod[method] || { count: 0, revenue: 0 });
          byMethod[method].count++;
          byMethod[method].revenue += value;

          const inst = p.installments || 1;
          byInstall[inst] = (byInstall[inst] || 0) + 1;

          if (p.firstDigits) {
            ordersWithBin++;
            const { bank, brand } = await resolveBank(p.firstDigits);
            const bankName  = bank  || 'Desconocido';
            const brandName = brand || method;
            const comboKey  = `${bankName} / ${brandName}`;

            byBank[bankName]   = (byBank[bankName]   || { count: 0, revenue: 0 });
            byBank[bankName].count++;
            byBank[bankName].revenue += value;

            byBrand[brandName] = (byBrand[brandName] || { count: 0, revenue: 0 });
            byBrand[brandName].count++;
            byBrand[brandName].revenue += value;

            byBankBrand[comboKey] = (byBankBrand[comboKey] || { count: 0, revenue: 0 });
            byBankBrand[comboKey].count++;
            byBankBrand[comboKey].revenue += value;
          } else {
            ordersNoBin++;
          }
        }
      }
    }

    // Ordenar por count desc
    const sort = obj => Object.entries(obj)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, v]) => ({ name: k, count: v.count, revenue: Math.round(v.revenue) }));

    return {
      period:         { from, to },
      totalAnalyzed:  details.length,
      totalRevenue:   Math.round(totalRevenue),
      ordersWithBin,
      ordersNoBin,
      byBank:         sort(byBank),
      byBrand:        sort(byBrand),
      byMethod:       sort(byMethod),
      byBankBrand:    sort(byBankBrand),
      byInstallments: Object.entries(byInstall)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([k, v]) => ({ installments: Number(k), count: v })),
    };
  }

  if (name === 'get_top_products') {
    const to        = input.to   || new Date().toISOString().split('T')[0];
    const from      = input.from || new Date(Date.now() - 30*86400000).toISOString().split('T')[0];
    const limit     = Math.min(input.limit || 20, 100);
    const maxOrders = Math.min(input.max_orders || 500, 1000);
    const dateFilter = `f_creationDate=creationDate:[${from}T00:00:00.000Z TO ${to}T23:59:59.999Z]`;

    // Traer órdenes paginando
    let allOrders = [];
    let currentPage = 1;
    let totalInVtex = null;
    while (allOrders.length < maxOrders) {
      const data = await vtexGet(
        `/api/oms/pvt/orders?orderBy=creationDate,desc&per_page=100&page=${currentPage}&${dateFilter}&f_status=invoiced`
      );
      const list = data.list || [];
      if (totalInVtex === null) totalInVtex = data.paging?.total || 0;
      allOrders = allOrders.concat(list);
      if (list.length < 100 || allOrders.length >= totalInVtex) break;
      currentPage++;
      await new Promise(r => setTimeout(r, 200));
    }

    // Traer detalles en lotes de 10
    const details = [];
    for (let i = 0; i < allOrders.length; i += 10) {
      const batch = allOrders.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(o => vtexGet(`/api/oms/pvt/orders/${o.orderId}`))
      );
      results.forEach(r => { if (r.status === 'fulfilled') details.push(r.value); });
      if (i + 10 < allOrders.length) await new Promise(r => setTimeout(r, 300));
    }

    // Acumular por producto
    const byProduct = {};
    for (const d of details) {
      for (const item of (d.items || [])) {
        const key = item.productId || item.id;
        if (!byProduct[key]) {
          byProduct[key] = { productId: key, name: item.name, skuId: item.id, quantity: 0, revenue: 0, orders: 0 };
        }
        byProduct[key].quantity += item.quantity || 0;
        byProduct[key].revenue  += ((item.price || 0) * (item.quantity || 0)) / 100;
        byProduct[key].orders++;
      }
    }

    const sorted = Object.values(byProduct)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, limit)
      .map(p => ({ ...p, revenue: Math.round(p.revenue * 100) / 100 }));

    return {
      period:         { from, to },
      ordersAnalyzed: details.length,
      topProducts:    sorted,
    };
  }

  if (name === 'get_customers') {
    const to        = input.to   || new Date().toISOString().split('T')[0];
    const from      = input.from || new Date(Date.now() - 30*86400000).toISOString().split('T')[0];
    const maxOrders = Math.min(input.max_orders || 200, 500);
    const dateFilter = `f_creationDate=creationDate:[${from}T00:00:00.000Z TO ${to}T23:59:59.999Z]`;

    // Búsqueda por email vía Master Data
    if (input.email) {
      const profile = await vtexGet(
        `/api/dataentities/CL/search?email=${encodeURIComponent(input.email)}&_fields=id,firstName,lastName,email,phone,document,birthDate,gender`
      ).catch(() => []);
      const orders = await vtexGet(
        `/api/oms/pvt/orders?orderBy=creationDate,desc&per_page=50&clientEmail=${encodeURIComponent(input.email)}`
      ).catch(() => ({ list: [] }));
      return {
        profile: profile[0] || null,
        totalOrders: orders.paging?.total || 0,
        recentOrders: (orders.list || []).map(o => ({
          orderId:      o.orderId,
          status:       o.status,
          value:        (o.value || 0) / 100,
          creationDate: o.creationDate,
        }))
      };
    }

    // Sin email: agrupa por cliente desde órdenes del período
    let allOrders = [];
    let currentPage = 1;
    let totalInVtex = null;
    while (allOrders.length < maxOrders) {
      const data = await vtexGet(
        `/api/oms/pvt/orders?orderBy=creationDate,desc&per_page=100&page=${currentPage}&${dateFilter}`
      );
      const list = data.list || [];
      if (totalInVtex === null) totalInVtex = data.paging?.total || 0;
      allOrders = allOrders.concat(list);
      if (list.length < 100 || allOrders.length >= totalInVtex) break;
      currentPage++;
      await new Promise(r => setTimeout(r, 200));
    }

    const byCustomer = {};
    for (const o of allOrders) {
      const email = o.clientProfileData?.email || 'desconocido';
      if (!byCustomer[email]) {
        byCustomer[email] = {
          email,
          name: `${o.clientProfileData?.firstName || ''} ${o.clientProfileData?.lastName || ''}`.trim(),
          orders: 0,
          totalSpent: 0,
          lastOrder: o.creationDate,
        };
      }
      byCustomer[email].orders++;
      byCustomer[email].totalSpent += (o.value || 0) / 100;
      if (o.creationDate > byCustomer[email].lastOrder) byCustomer[email].lastOrder = o.creationDate;
    }

    const customers = Object.values(byCustomer)
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .map(c => ({ ...c, totalSpent: Math.round(c.totalSpent * 100) / 100 }));

    return {
      period:          { from, to },
      ordersAnalyzed:  allOrders.length,
      uniqueCustomers: customers.length,
      customers,
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
