# Skill: Sincronización de precios y stock — Neumáticos Gallo

## Contexto del sistema

Este proyecto es un bot de WhatsApp + sistema de presupuestos para Neumáticos Gallo.
Los precios y stock se sincronizan desde archivos Excel en Google Drive hacia una hoja de Google Sheets llamada "Bot WhatsApp" (ID: `160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw`).

El bot corre permanentemente en Railway. El sync se corre manualmente desde la PC cuando el usuario sube archivos nuevos a Drive.

## Cómo correr el sync

```
cd "neumaticos-bot"
node scripts/sincronizar-fuentes.js
```

## Archivos fuente (carpeta Drive `11Ham__W-bVOJtaMsZQHRap-orDV6cpek`)

| Archivo | Qué aporta |
|---|---|
| `Inventario Gallo *.xlsx` | Stock Victoria + Nordelta + precio de venta |
| `Celsur *.xlsx` | Stock Express Michelin/BFG |
| `Lista de Precios Mostrador Gallo Michelin BFGoodrich.xlsx` | Precio lista Michelin/BFG |
| `LP Hankook *.xlsx` | Stock Express + precio Hankook |
| `LP Yokohama *.xlsx` | Stock Express + precio Yokohama |
| `Ling Long *.xlsx` | Stock Express + precio Linglong |
| `Neumasur Nexen *.xlsx` | Stock Express + precio Nexen |

Cuando hay múltiples versiones del mismo archivo, se toma el de nombre lexicográficamente mayor (más reciente).

## Reglas de precio

1. Si el producto tiene stock en Victoria o Nordelta → `PrecioUnitario` del inventario Gallo (todas las marcas, incluso Michelin/BFG)
2. Sin stock propio + Michelin o BFGoodrich → precio de lista oficial
3. Sin stock propio + Hankook/Yokohama/Linglong/Nexen → precio del archivo del proveedor (solo match exacto por SKU)

## Reglas de stock Express

- Michelin/BFG: match por CAI exacto vía Celsur
- Hankook: SKU = `HA` + cod. producto del archivo
- Yokohama: SKU = `YO` + CODIGO del archivo
- Linglong: SKU directo (sin prefijo)
- Nexen: SKU = `NE` + codigo del archivo Neumasur

**Regla anti-mezcla:** si el producto tiene CodArt (está en inventario Gallo), NO se usa fallback por medida. Solo match exacto por SKU. Si no matchea → Express = 0.

## Columnas que actualiza el sync (y las que NO toca)

| Columna | ¿Se actualiza? |
|---|---|
| G — Stock Victoria | ✅ Siempre |
| H — Stock Nordelta | ✅ Siempre |
| I — Stock Express | ✅ Siempre |
| J — Precio | ✅ Siempre |
| E — Modelo | ✅ Solo si está vacío y hay CodArt |
| A, B, C, D, F | ❌ Nunca (no tocar descripción, marca, medida, códigos) |

## Descuentos de reventa

| Marca | Descuento |
|---|---|
| Michelin | 35% |
| BFGoodrich | 35% |
| Yokohama | 32% |
| Nexen | 32% |
| Hankook | 28% |
| Linglong | 28% |
| Giti | 33% |
| GTRadial | 33% |

Si el producto está en promo de invierno: precio base reventa = precio / 0.9 antes de aplicar descuento.

## Productos ocultos por defecto

Neumáticos de nieve/invierno no se muestran salvo que el cliente los pida. Palabras clave: `alpin`, `ice snow`, `x-ice`, `xice`, `agilis alpin`.

## Errores comunes

- **Inventario Gallo 0 productos**: el archivo .xls puede tener nombre de hoja distinto. El script usa `wb.SheetNames[0]` para tomar la primera hoja.
- **Duplicados en la hoja**: correr `node scripts/limpiar-duplicados.js` (preview) y `--ejecutar` para borrar.
- **Producto no aparece en el bot**: verificar que tenga precio > 0, stock > 0 en alguna columna, y que no sea neumático de nieve.
- **Cambios de código no se reflejan en Railway**: hacer `git push` al repositorio de GitHub — Railway hace deploy automático.

## Estructura del proyecto

```
neumaticos-bot/
├── index.js                        # Bot WhatsApp + servidor presupuestos (corre en Railway)
├── scripts/
│   ├── sincronizar-fuentes.js      # Script de sync (corre manual en PC)
│   ├── limpiar-duplicados.js       # Limpia filas duplicadas por CodAlt
│   └── limpiar-duplicados-modelo.js # Limpia duplicados por marca+modelo+medida
└── public/
    └── presupuesto.html            # Frontend del sistema de presupuestos
```
