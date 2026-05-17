
        const statusConfig = {
            'Новий': 'bg-blue-50 text-blue-600 ring-blue-100',
            'В роботі': 'bg-amber-50 text-amber-600 ring-amber-100',
            'Відправлено': 'bg-violet-50 text-violet-600 ring-violet-100',
            'Завершено': 'bg-emerald-50 text-emerald-600 ring-emerald-100',
            'Відмова': 'bg-rose-50 text-rose-600 ring-rose-100',
            'Видалено': 'bg-slate-100 text-slate-400 ring-slate-200'
        };

        let currentView = 'orders';
        let suppliersList = [];

        function switchView(view) {
            currentView = view;
            document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
            const btn = document.getElementById(`btn-${view}`);
            if (btn) btn.classList.add('active');

            const titles = { 'orders': 'ЗАМОВЛЕННЯ', 'warehouse': 'СКЛАД' };
            document.getElementById('current-view-title').innerText = titles[view] || view.toUpperCase();

            document.querySelectorAll('.view-content').forEach(el => el.classList.remove('active'));
            const targetContent = document.getElementById(`view-${view}`);
            if (targetContent) targetContent.classList.add('active');

            refreshData();
        }

        function refreshData() {
            if (['orders', 'archive', 'deleted'].includes(currentView)) loadOrders();
            if (currentView === 'warehouse') loadWarehouseData();
            if (currentView === 'stock') loadStockData();
        }

        // --- ЛОГІКА ЗАМОВЛЕНЬ ---
        async function loadOrders() {
            try {
                const search = document.getElementById('searchInput').value;
                const res = await fetch(`/api/orders?view=${currentView}&search=${encodeURIComponent(search)}`);
                const data = await res.json();
                const table = document.getElementById('ordersTable');
                if(!Array.isArray(data) || !data.length) {
                    table.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400">Пусто</td></tr>`;
                    return;
                }
                
                table.innerHTML = data.map(o => `
                <tr class="hover:bg-slate-50 transition-all group">
                    <td class="px-8 py-6">
                        <div class="font-bold text-slate-800 text-sm">${o.fullName}</div>
                        <div class="text-[10px] text-slate-400 font-bold uppercase mt-1"><i class="fa-solid fa-phone text-[9px]"></i> ${o.phone}</div>
                    </td>
                    <td class="px-6 py-6">
                        <div class="text-[11px] font-black text-slate-800 uppercase">${o.article} <span class="text-[10px] text-slate-400 font-bold">(${o.color || '-'} / ${o.size || '-'})</span></div>
                        <div class="mt-1"><span class="text-[9px] font-black bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded border border-emerald-200/50">${o.price - o.cost} грн</span></div>
                    </td>
                    <td class="px-6 py-6">
                        <input type="text" value="${o.ttn || ''}" onchange="updateOrder(${o.id}, 'ttn', this.value)" placeholder="Ввести ТТН..."
                            class="w-full max-w-[150px] text-xs font-mono font-bold bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 outline-none">
                    </td>
                    <td class="px-6 py-6">
                        <select onchange="updateOrder(${o.id}, 'status', this.value)" 
                            class="text-[10px] font-black px-3 py-1.5 rounded-full ring-1 ring-inset cursor-pointer ${statusConfig[o.status] || 'bg-slate-100'}">
                            ${Object.keys(statusConfig).map(s => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s.toUpperCase()}</option>`).join('')}
                        </select>
                    </td>
                    <td class="px-6 py-6">
                        <input type="text" value="${o.comment || ''}" onchange="updateOrder(${o.id}, 'comment', this.value)" placeholder="Замітка..."
                            class="w-full bg-transparent text-[11px] text-slate-400 border-none outline-none italic">
                    </td>
                    <td class="px-8 py-6 text-right">
                        ${currentView !== 'deleted' ? 
                            `<button onclick="updateOrder(${o.id}, 'status', 'Видалено')" class="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 transition-all p-2 bg-slate-50 rounded-lg"><i class="fa-solid fa-trash-can"></i></button>` : 
                            `<button onclick="updateOrder(${o.id}, 'status', 'Новий')" class="text-violet-500 text-[10px] font-black uppercase hover:underline">Відновити</button>`
                        }
                    </td>
                </tr>`).join('');
            } catch (e) { console.error(e); }
        }

        document.getElementById('addOrderForm').onsubmit = async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.target));
            try {
                const res = await fetch('/api/orders/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
                const result = await res.json();
                if (!res.ok) throw new Error(result.error || 'Помилка сервера');
                closeModal('orderModal'); e.target.reset(); loadOrders();
            } catch (err) { alert('Помилка: ' + err.message); }
        };

        async function updateOrder(id, field, value) {
            await fetch(`/api/orders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value }) });
            loadOrders();
        }

        // --- ЛОГІКА СКЛАДУ ---
        async function loadWarehouseData() {
            try {
                const supRes = await fetch('/api/warehouse/suppliers');
                const supData = await supRes.json();
                suppliersList = Array.isArray(supData) ? supData : [];
                renderSuppliers();
                
                const prodRes = await fetch('/api/warehouse/products');
                const prodData = await prodRes.json();
                renderProducts(Array.isArray(prodData) ? prodData : []);
            } catch (e) { console.error(e); }
        }

        function renderSuppliers() {
            const list = document.getElementById('suppliersList');
            const select = document.getElementById('supplierSelect');
            
            list.innerHTML = suppliersList.map(s => `
                <div class="flex justify-between items-center bg-slate-50 px-4 py-2.5 rounded-lg border border-slate-100 group">
                    <span class="text-xs font-bold text-slate-700">${s.name}</span>
                    <button onclick="deleteSupplier(${s.id})" class="text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"><i class="fa-solid fa-xmark"></i></button>
                </div>
            `).join('');

            select.innerHTML = `<option value="">-- Оберіть постачальника --</option>` + 
                suppliersList.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        }

        function renderProducts(products) {
            const table = document.getElementById('productsTable');
            if(!products.length) return table.innerHTML = `<tr><td colspan="5" class="p-10 text-center text-slate-400 font-medium">База товарів порожня</td></tr>`;
            
            table.innerHTML = products.map(p => {
                const profit = p.price - p.cost;
                const linksHtml = p.links ? p.links.split('\n').filter(l=>l.trim()).map((link, i) => 
                    `<a href="${link.trim()}" target="_blank" class="inline-flex items-center gap-1 bg-indigo-50 text-indigo-600 px-2 py-1 rounded text-[9px] font-bold uppercase hover:bg-indigo-100 mb-1 mr-1 transition-colors"><i class="fa-solid fa-link"></i> Лінк ${i+1}</a>`
                ).join('') : '<span class="text-slate-300 text-[10px]">Немає</span>';

                return `
                <tr class="hover:bg-slate-50 transition-all group border-b border-slate-50 last:border-0">
                    <td class="px-6 py-5">
                        <div class="text-[12px] font-black text-slate-800 uppercase tracking-tighter">${p.article}</div>
                        <div class="text-[10px] text-slate-500 font-medium mt-0.5">${p.name}</div>
                    </td>
                    <td class="px-6 py-5">
                        <div class="flex items-center gap-2 text-[10px] font-bold">
                            <span class="text-rose-500">Соб: ${p.cost}</span> / 
                            <span class="text-slate-600">Сайт: ${p.price}</span>
                        </div>
                        <div class="mt-1 text-[11px] font-black text-emerald-600 bg-emerald-50 inline-block px-2 py-0.5 rounded">Різниця: +${profit} грн</div>
                    </td>
                    <td class="px-6 py-5">
                        <span class="text-[11px] font-bold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-md">${p.supplier_name || 'Не вказано'}</span>
                    </td>
                    <td class="px-6 py-5 max-w-[150px] flex-wrap">${linksHtml}</td>
                    <td class="px-6 py-5 text-right">
                        <button onclick="deleteProduct(${p.id})" class="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 transition-all p-2 bg-slate-50 rounded-lg"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>`
            }).join('');
        }

        document.getElementById('addSupplierForm').onsubmit = async (e) => {
            e.preventDefault();
            try {
                const res = await fetch('/api/warehouse/suppliers', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name: e.target.name.value}) });
                const result = await res.json();
                if (!res.ok) throw new Error(result.error || 'Помилка сервера');
                e.target.reset(); loadWarehouseData();
            } catch (err) { alert('Помилка: ' + err.message); }
        };

        async function deleteSupplier(id) { await fetch(`/api/warehouse/suppliers/${id}`, { method: 'DELETE' }); loadWarehouseData(); }

        document.getElementById('addProductForm').onsubmit = async (e) => {
            e.preventDefault();
            try {
                const res = await fetch('/api/warehouse/products', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
                const result = await res.json();
                if (!res.ok) throw new Error(result.error || 'Помилка сервера');
                closeModal('productModal'); e.target.reset(); loadWarehouseData();
            } catch (err) { alert('Помилка: ' + err.message); }
        };

        async function deleteProduct(id) { await fetch(`/api/warehouse/products/${id}`, { method: 'DELETE' }); loadWarehouseData(); }

        // --- ЛОГІКА НАЯВНОСТІ ---
        async function loadStockData() {
            try {
                const prodRes = await fetch('/api/warehouse/products');
                const products = await prodRes.json();
                document.getElementById('stockProductSelect').innerHTML = `<option value="">-- Оберіть товар --</option>` + 
                    products.map(p => `<option value="${p.id}">${p.article} (${p.name})</option>`).join('');

                const res = await fetch('/api/stock');
                const data = await res.json();
                const table = document.getElementById('stockTable');
                if(!data.length) return table.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-slate-400 font-medium">Наявність порожня</td></tr>`;
                
                table.innerHTML = data.map(s => `
                <tr class="hover:bg-slate-50 transition-all group">
                    <td class="px-8 py-5">
                        <div class="text-[12px] font-black text-slate-800 uppercase tracking-tighter">${s.article}</div>
                        <div class="text-[10px] text-slate-500 font-medium">${s.product_name}</div>
                    </td>
                    <td class="px-6 py-5">
                        <span class="bg-slate-100 text-slate-700 font-bold px-2 py-1 rounded text-[10px] mr-1">К: ${s.color || '-'}</span>
                        <span class="bg-slate-100 text-slate-700 font-bold px-2 py-1 rounded text-[10px]">Р: ${s.size || '-'}</span>
                    </td>
                    <td class="px-6 py-5">
                        <input type="number" value="${s.quantity}" min="0" onchange="updateStock(${s.id}, this.value)" 
                            class="w-20 text-sm font-black bg-slate-50 border border-slate-100 rounded-lg px-3 py-1.5 outline-none focus:border-amber-400">
                    </td>
                    <td class="px-8 py-5 text-right">
                        <button onclick="deleteStock(${s.id})" class="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500 transition-all p-2 bg-slate-50 rounded-lg"><i class="fa-solid fa-trash-can"></i></button>
                    </td>
                </tr>`).join('');
            } catch (e) { console.error(e); }
        }

        document.getElementById('addStockForm').onsubmit = async (e) => {
            e.preventDefault();
            try {
                const res = await fetch('/api/stock', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
                const result = await res.json();
                if (!res.ok) throw new Error(result.error || 'Помилка сервера');
                closeModal('stockModal'); e.target.reset(); loadStockData();
            } catch (err) { alert('Помилка: ' + err.message); }
        };

        async function updateStock(id, quantity) {
            await fetch(`/api/stock/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity }) });
            loadStockData();
        }

        async function deleteStock(id) {
            await fetch(`/api/stock/${id}`, { method: 'DELETE' });
            loadStockData();
        }

        function openModal(id) { document.getElementById(id).classList.add('modal-active'); }
        function closeModal(id) { document.getElementById(id).classList.remove('modal-active'); }
        function debounceSearch() { clearTimeout(window.searchTimer); window.searchTimer = setTimeout(loadOrders, 400); }
        async function logout() { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login.html'; }

        refreshData();
    