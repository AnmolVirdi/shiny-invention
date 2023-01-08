import express, { Request, Response, NextFunction, Application } from 'express'
import { config } from 'dotenv'
import puppeteer, { Page, PuppeteerLaunchOptions } from 'puppeteer-core'
import { PrismaClient } from '@prisma/client'
import { camelize } from './helpers/index'
import { CronJob } from 'cron'

const prisma = new PrismaClient()

const app: Application = express()

// regular middlewares
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// config
config()

// Type interfaces for variables
interface CategoryLinks {
  title: string | undefined
  link: string | undefined | null
}

interface ProductLink {
  link: string | undefined | null
}

interface Spec {
  id?: string
  mountingSystem?: string
  caliber?: string
  muzzleThread?: string
  barrelLength?: string
  barrelProfile?: string
  productWeight?: string
  length?: string
  magazine?: string
  case?: string
  manufacturer?: string
}

interface Product {
  model: string
  manufacturer: string
  itemNumber: string
  price: string | null
  caliber: string
  type: string
  platform: string
  description: string
  miscDetails: string
  link: string | undefined | null
  image: string
  specs: Spec
}
async function extractAllProductLinks(): Promise<number | undefined> {
  try {
    const config: PuppeteerLaunchOptions = {
      // headless: true,
      args: ['--no-sandbox'], // '--disable-dev-shm-usage'
    }
    if (process.env.PUPPETEER_CONFIG_EXECUTABLE_PATH) {
      config.executablePath = process.env.PUPPETEER_CONFIG_EXECUTABLE_PATH
    }
    console.log('Launching puppeteer...')
    console.log('Config: ', JSON.stringify(config, null, 2))
    const browser = await puppeteer.launch(config)
    console.log('Creating page...')
    const page: Page = await browser.newPage()
    console.log('Loading page...')
    await page.goto('https://danieldefense.com/')
    await page.setDefaultNavigationTimeout(0)
    console.log('Scraper running...')

    // const navbarProductLinks = await page.evaluate(() => {
    //   document.querySelector(".navigation")?.innerHTML;
    // });

    let navbarProductLinks: CategoryLinks[] = await page.$$eval(
      '.submenu li',
      (elements) => {
        return elements.map((e: HTMLLIElement) => {
          if (e.innerHTML.includes('ul')) {
            const newLink = e.querySelector('ul li')
            if (newLink?.innerHTML.includes('ul')) {
              const newLink2 = newLink?.querySelector('ul li')
              return {
                title: newLink2?.querySelector('a')?.innerText,
                link: newLink2?.querySelector('a')?.getAttribute('href'),
              }
            } else {
              return {
                title: newLink?.querySelector('a')?.innerText,
                link: newLink?.querySelector('a')?.getAttribute('href'),
              }
            }
          } else {
            return {
              title: e.querySelector('a')?.innerText,
              link: e.querySelector('a')?.getAttribute('href'),
            }
          }
        })
      },
    )

    console.log('Created navbarProductLinks Object', navbarProductLinks)

    // First 42 elements in the navbarProductLinks array are the links we require for scraping the products.
    navbarProductLinks = navbarProductLinks.slice(0, 42)
    // Getting all unique elemts in the array (unique links because some links gets repeated twice or thrice)
    navbarProductLinks = [
      ...new Map(
        navbarProductLinks.map((item) => [item['link'], item]),
      ).values(),
    ]

    console.log('Created navbarProductLinks Map', navbarProductLinks)

    // Extracting single product links from each category from Navbar Product Links
    for (let i = 0; i < navbarProductLinks.length; i++) {
      console.log(`Extracting link ${i}...`)
      let singleCategoryProductLinks: ProductLink[] | undefined =
        await extractLinksOfSingleProductCategory(navbarProductLinks[i], page)

      // Identifying if the product is a firearm or not
      const isFirearm: boolean =
        navbarProductLinks[i].link?.includes('rifles') ||
        navbarProductLinks[i].link?.includes('pistols')
          ? true
          : false

      console.log(`Is it a Firearm: `, isFirearm)

      singleCategoryProductLinks = singleCategoryProductLinks
        ? singleCategoryProductLinks
        : []

      for (let j = 0; j < singleCategoryProductLinks.length; j++) {
        if (!singleCategoryProductLinks[j]?.link) continue
        let product: Product = {
          model: '',
          manufacturer: '',
          itemNumber: '',
          price: null,
          specs: {},
          caliber: '',
          type: '',
          platform: '',
          description: '',
          miscDetails: '',
          link: '',
          image: '',
        }
        await page.goto(
          `${
            singleCategoryProductLinks
              ? singleCategoryProductLinks[j]?.link
              : 'https://danieldefense.com/'
          }`,
        )

        const itemNumber = await page.evaluate(
          () => document.querySelector('.sku div.value')?.textContent,
        )

        let firearmExists: boolean = false
        let partExists: boolean = false

        if (itemNumber !== '' && isFirearm) {
          const firearm = await prisma.firearm.findUnique({
            where: {
              itemNO: itemNumber ? itemNumber : '',
            },
          })

          firearmExists = firearm ? true : false
        } else if (itemNumber !== '' && !isFirearm) {
          const part = await prisma.part.findUnique({
            where: {
              itemNO: itemNumber ? itemNumber : '',
            },
          })

          partExists = part ? true : false
        }

        const model = await page.evaluate(
          () => document.querySelector('.page-title span')?.textContent,
        )

        product['model'] = model ? model : ''

        product['itemNumber'] = itemNumber ? itemNumber : ''

        const price = await page.evaluate(
          () => document.querySelector('span.price')?.textContent,
        )

        product['price'] = price?.length ? price.split('$')[1] : null

        let inStock = await page.evaluate(
          () =>
            document.querySelector(
              '.swatch-wrapper .swatch-details .swatch-text .stock',
            )?.classList,
        )

        console.log('inStock: ', inStock)

        const specs: {
          attribute: string
          value: string
        }[] = await page.$$eval(
          '#product-attribute-specs-table tr',
          (elements) => {
            return elements.map((e) => {
              return {
                attribute: `${
                  e.querySelector('th')?.textContent
                    ? e.querySelector('th')?.textContent
                    : ''
                }`,
                value: `${
                  e.querySelector('td')?.textContent
                    ? e.querySelector('td')?.textContent
                    : ''
                }`,
              }
            })
          },
        )

        console.log(specs)

        let specTable = {
          mountingSystem: '',
          caliber: '',
        }
        type T = keyof typeof specTable

        for (let m = 0; m < specs.length; m++) {
          const attr: string = camelize(specs[m].attribute)
          specTable[attr as T] = specs[m].value
        }

        const description = await page.evaluate(
          () =>
            document.querySelector('div.initial-description p')?.textContent,
        )

        product['description'] = description ? description : ''

        let dbSavedDoc
        let vendor = await prisma.vendor.findUnique({
          where: {
            vendor: 'DanielDefense',
          },
        })

        if (!vendor) {
          vendor = await prisma.vendor.create({
            data: {
              vendor: 'DanielDefense',
              website: 'https://danieldefense.com/',
            },
          })
        }

        if (isFirearm) {
          // Saving data of all firearms to Firearm Collection in MongoDB
          dbSavedDoc = await prisma.firearm.upsert({
            where: {
              itemNO: product.itemNumber,
            },
            update: {
              model: product.model,
              price: product.price ? product.price : '',
              description: product.description,
              type: 'AR',
              itemNO: product.itemNumber,
            },
            create: {
              model: product.model,
              price: product.price ? product.price : '',
              description: product.description,
              type: 'AR',
              itemNO: product.itemNumber,
              specs: {
                create: specTable,
              },
              link: singleCategoryProductLinks[j]?.link,
            },
          })

          // Upserting the data of all Firearms in Listing Collection
          await prisma.listing.upsert({
            where: {
              firearmId: dbSavedDoc.id,
            },
            update: {
              price: product.price ? product.price : '',
              firearmId: dbSavedDoc.id,
              inStock:
                inStock !== undefined && inStock['1'] === 'in-stock'
                  ? true
                  : false,
              vendorId: vendor?.id,
              currency: 'USD',
              link: singleCategoryProductLinks[j]?.link,
            },
            create: {
              price: product.price ? product.price : '',
              firearmId: dbSavedDoc.id,
              inStock:
                inStock !== undefined && inStock['1'] === 'in-stock'
                  ? true
                  : false,
              vendorId: vendor?.id,
              currency: 'USD',
              link: singleCategoryProductLinks[j]?.link,
            },
          })
        } else {
          // Saving data of all parts to Part Collection in MongoDB
          dbSavedDoc = await prisma.part.upsert({
            where: {
              itemNO: product.itemNumber,
            },
            update: {
              model: product.model,
              price: product.price ? product.price : '',
              description: product.description,
              type: 'PART',
              itemNO: product.itemNumber,
            },
            create: {
              model: product.model,
              price: product.price ? product.price : '',
              description: product.description,
              type: 'PART',
              itemNO: product.itemNumber,
              specs: {
                create: specTable,
              },
              link: singleCategoryProductLinks[j]?.link,
            },
          })

          // Upserting the data of all Parts in Listing Collection
          await prisma.listing.upsert({
            where: {
              partId: dbSavedDoc.id,
            },
            update: {
              price: product.price ? product.price : '',
              partId: dbSavedDoc.id,
              inStock:
                inStock !== undefined && inStock['1'] === 'in-stock'
                  ? true
                  : false,
              vendorId: vendor?.id,
              currency: 'USD',
              link: singleCategoryProductLinks[j]?.link,
            },
            create: {
              price: product.price ? product.price : '',
              partId: dbSavedDoc.id,
              inStock:
                inStock !== undefined && inStock['1'] === 'in-stock'
                  ? true
                  : false,
              vendorId: vendor?.id,
              currency: 'USD',
              link: singleCategoryProductLinks[j]?.link,
            },
          })
        }

        console.log(dbSavedDoc)
      }
    }

    await browser.close()
    return 0
  } catch (err) {
    console.log(err)
  }
}

async function extractLinksOfSingleProductCategory(
  productLink: ProductLink,
  page: Page,
): Promise<ProductLink[] | undefined> {
  try {
    console.log(`${productLink.link}?product_list_limit=all`)

    await page.goto(`${productLink.link}?product_list_limit=all`)
    let singleCategoryProductLinks: ProductLink[] = await page.$$eval(
      'ol.product-items li.product-item div.product-item-info',
      (elements: HTMLElement[]): ProductLink[] => {
        return elements.map((e: HTMLElement): ProductLink => {
          return {
            link: e.querySelector('a')?.getAttribute('href'),
          }
        })
      },
    )

    return singleCategoryProductLinks
  } catch (err) {
    console.log(err)
  }
}

const run = async () => {
  await extractAllProductLinks()
}

export async function main() {
  console.log('Bootstrapping Prisma connection...')
  await prisma.$connect()
  console.log('Prisma Connected.')

  configureCronJob()

  if (process.env.RUN_ON_STARTUP === 'true') {
    console.log('Running on startup...')
    await run()
  }

  return true
}

async function configureCronJob() {
  const schedule = '*/10 * * * *'
  console.log(`Creating Cron Job with schedule ${schedule} ...`)
  new CronJob(schedule, run, null, true, 'America/Los_Angeles')
  console.log('Cron Job Created.')
}

const PORT: Number = Number(process.env.PORT || '8080')

app.listen(PORT, () => {
  main()
    .then(async () => {
      await prisma.$disconnect()
    })
    .catch(async (e) => {
      console.error(e)
      await prisma.$disconnect()
      process.exit(1)
    })
})
