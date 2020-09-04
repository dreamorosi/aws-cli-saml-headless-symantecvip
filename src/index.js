const puppeteer = require('puppeteer')
require('dotenv').config()
const assert = require('assert')
const inquirer = require('inquirer');
const { STSClient, AssumeRoleWithSAMLCommand } = require('@aws-sdk/client-sts');

const getUserInfo = async () => {
    // TODO: proper logging
    // TODO: add keytar fallback if no env (only outside of container)
    // const pass = await keytar.getPassword('aws-saml', os.userInfo().username)
    // const keytar = require('keytar');
    // const os = require("os");
    // TODO: add support for command line input if previous two not present
    return {
        email: process.env.EMAIL,
        pass: process.env.PASS,
        federationUrl: process.env.URL,
        idpName: process.env.IDPNAME
    }
}

const getSAMLnRoles = async (email, pass, url) => {
    // TODO: proper logging
    // Init a new browser
    let browser = await puppeteer.launch({
        args: [
            // Required for Docker version of Puppeteer
            '--no-sandbox',
            '--disable-setuid-sandbox',
            // This will write shared memory files into /tmp instead of /dev/shm,
            // because Docker’s default for /dev/shm is 64MB
            '--disable-dev-shm-usage'
        ]
    })

    // Open new tab & attempt login (will redirect to Symantec VIP login form).
    let page = await browser.newPage()
    const response = await page.goto(url)

    // Make sure correct page is loaded.
    assert(response.ok())
    // TODO: add more checks.

    // Fill auth form and submit.
    await page.type('#userNameInput', email);
    await page.type('#passwordInput', pass);
    await page.click('#submitButton');
    // TODO: account for wrong credentials

    // Wait for login to be verified and second page to appear.
    await page.waitFor('#vipSkipBtn');
    await page.click('#vipSkipBtn');

    // Wait for AWS SAML Login page to appear.
    await page.waitFor('#saml_form')

    // Get SAML Response from page.
    const saml = await page.evaluate(() => {
        return document.querySelector('#saml_form input[name="SAMLResponse"]').value
    })
    console.log('Saml Token OK')

    // TODO: Account for missing DOM Nodes/Attributes. 
    // Get AWS Accounts and IAM Roles.
    const roles = await page.evaluate(() => {
        let accountsNodes = document.querySelectorAll('.saml-account:not([id])')
        let accounts = {}
        accountsNodes.forEach((el) => {
            let accountLabel = el.querySelector('.saml-account-name').textContent
            let accountId = accountLabel.match(/\d{12}/)
            let rolesContainerNode = el.querySelectorAll(`.saml-account[id] .saml-role`)
            let roles = []
            rolesContainerNode.forEach(el => {
                let roleLabel = el.querySelector('label')
                roles.push({
                    name: roleLabel.textContent,
                    arn: roleLabel.getAttribute('for')
                })
            })
            accounts[accountId] = roles
        })
        return accounts
    })

    // Dispose of browser.
    await page.close()
    await browser.close()

    return {
        saml: saml,
        roles: roles
    }
}

const chooseRole = async (accounts) => {
    // TODO: proper logging
    var prompt = inquirer.createPromptModule();

    // Create choices array.
    let choices = []
    Object.keys(accounts).forEach(account => {
        choices.push(new inquirer.Separator(`-- ${account} --`))
        accounts[account].forEach(role => choices.push(`${role.name} - ${role.arn}`))
    })

    // TODO: check what happens if user presses ^C
    // Prompt user to choose.
    let answer = await prompt({
        type: 'list',
        name: 'role',
        message: 'Choose an IAM Role:',
        choices: choices
    })

    // Extract IAM Role ARN and AWS Account ID.
    const { role } = answer
    let arn = role.split(' - ')[1]
    let account = arn.match(/\d{12}/)[0]

    return {
        roleArn: arn,
        accountId: account
    }
}

const assumeRole = async (chosenRole, saml, idpName) => {
    // TODO: proper logging
    // TODO: check for default AWS Region
    // Create STS Client and build Assume Role w/ SAML command.
    let client
    let command
    try {
        client = new STSClient({ region: 'eu-west-1' });
        command = new AssumeRoleWithSAMLCommand({
            RoleArn: chosenRole.roleArn,
            PrincipalArn: `arn:aws:iam::${chosenRole.accountId}:saml-provider/${idpName}`,
            SAMLAssertion: saml,
            DurationSeconds: 7200
        })
    } catch (err) {
        console.error(err)
        console.error('Unable to create STS Client/Command.')
    }
    // Attempt authentication.
    try {
        const response = await client.send(command);
        const { Credentials: credentials } = response
        return {
            accessKey: credentials.AccessKeyId,
            secretkey: credentials.SecretAccessKey,
            token: credentials.SessionToken,
            expiration: credentials.Expiration
        }
    } catch (err) {
        console.error(err);
        console.error('Unable to assume IAM Role.')
    }
}

(async () => {
    const userInfo = await getUserInfo()
    console.log('Authenticating')
    // TODO: add support for default role; in that case retrieve SAML & verify role existence.
    const { saml, roles } = await getSAMLnRoles(
        userInfo.email,
        userInfo.pass,
        userInfo.federationUrl
    )
    // console.log(response.accounts)

    // TODO: check if there is only 1 account & 1 role OR default role is set, in that case skip this step.
    const chosenNole = await chooseRole(roles)

    const credentials = await assumeRole(chosenNole, saml, userInfo.idpName)

    console.log(`aws_access_key_id = ${credentials.accessKey}`)
    console.log(`aws_secret_access_key = ${credentials.secretkey}`)
    console.log(`aws_session_token  = ${credentials.token}`)

    console.log(`Credentials will expire at ${credentials.expiration}`)
})()