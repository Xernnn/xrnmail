import { describe, expect, it } from 'vitest'
import { oddLink } from '@shared/links'

describe('a link that says one place and goes to another', () => {
  // A click opened it with no word: "paypal.com" in the words and evil.example in the address, or
  // an address that dresses itself up with a name before an @.
  it('is caught when its words are an address at another company', () => {
    expect(oddLink('https://evil.example/login', 'https://paypal.com/login')).toEqual({ host: 'evil.example', shown: 'paypal.com' })
    expect(oddLink('https://evil.example/', 'www.paypal.com')).toEqual({ host: 'evil.example', shown: 'www.paypal.com' })
    expect(oddLink('https://evil.example/', ' PayPal.com ')).toEqual({ host: 'evil.example', shown: 'paypal.com' })
    expect(oddLink('https://bank.evil.com.au/', 'bank.com.au')).toEqual({ host: 'bank.evil.com.au', shown: 'bank.com.au' })
    expect(oddLink('https://xn--pypal-4ve.com/', 'paypal.com')).toEqual({ host: 'xn--pypal-4ve.com', shown: 'paypal.com' })
  })

  it('is caught when the address has a name before an @', () => {
    expect(oddLink('https://paypal.com@evil.example/', 'Sign in')).toEqual({ host: 'evil.example', shown: 'paypal.com' })
    expect(oddLink('https://paypal.com:secure@evil.example/', 'https://paypal.com@evil.example/')).toEqual({ host: 'evil.example', shown: 'paypal.com' })
  })

  it('leaves ordinary links alone', () => {
    expect(oddLink('https://shop.example/sale', 'See the sale')).toBeNull()
    expect(oddLink('https://links.shop.example/click?u=1', 'shop.example')).toBeNull()
    expect(oddLink('https://shop.example/a', 'https://shop.example/a')).toBeNull()
    expect(oddLink('https://www.shop.co.uk/', 'shop.co.uk')).toBeNull()
    expect(oddLink('https://shop.example/', 'Visit us at shop.example today')).toBeNull() // words, not an address
    expect(oddLink('mailto:a@b.example', 'c@d.example')).toBeNull()
    expect(oddLink('not a url', 'paypal.com')).toBeNull()
    expect(oddLink('https://shop.example/', 'v1.2')).toBeNull()
  })
})
