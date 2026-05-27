import {
  Badge,
  Box,
  BreadcrumbCurrentLink,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbRoot,
  BreadcrumbSeparator,
  Button,
  Container,
  Flex,
  Grid,
  Heading,
  HStack,
  Input,
  InputGroup,
  Stack,
  Text,
  VStack,
} from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { Link as RouterLink } from 'react-router-dom'
import PageBreadcrumb from './components/PageBreadcrumb'
import PageHeader from './components/PageHeader'
import ReloadButton from './components/ReloadButton'
import ThemeToggleButton from './components/ThemeToggleButton'

const fadeUp = keyframes`
  from { opacity: 0; transform: translate3d(0, 18px, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
`

const drift = keyframes`
  0% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(-18px, 16px, 0); }
  100% { transform: translate3d(0, 0, 0); }
`

const navSections = [
  {
    title: 'Overview',
    items: ['Introduction', 'Migration', 'CLI', 'Figma'],
  },
  {
    title: 'Build',
    items: ['Theme tokens', 'Recipes', 'Compositions', 'Accessibility'],
  },
  {
    title: 'Deploy',
    items: ['Release notes', 'Changelog', 'Telemetry'],
  },
]

const tocItems = [
  { label: 'Installation', depth: 0 },
  { label: 'Usage', depth: 1 },
  { label: 'Typegen', depth: 1 },
  { label: 'Snippets', depth: 1 },
  { label: 'FAQ', depth: 0 },
]

type NavItemProps = {
  label: string
  active?: boolean
}

const NavItem = ({ label, active = false }: NavItemProps) => (
  <Box
    as="button"
    type="button"
    textAlign="left"
    w="full"
    px="3"
    py="2"
    borderRadius="md"
    bg={active ? 'tide.600' : 'transparent'}
    color={active ? 'ink.900' : 'ink.700'}
    fontWeight={active ? '600' : '500'}
    _hover={{
      bg: active ? 'tide.600' : 'sand.100',
      color: 'ink.900',
    }}
    transition="background 0.2s ease"
  >
    <Text fontSize="sm">{label}</Text>
  </Box>
)

const SearchGlyph = () => (
  <Box position="relative" w="16px" h="16px" color="ink.700">
    <Box
      position="absolute"
      top="1px"
      left="1px"
      w="10px"
      h="10px"
      border="2px solid currentColor"
      borderRadius="full"
    />
    <Box
      position="absolute"
      bottom="1px"
      right="0"
      w="6px"
      h="2px"
      bg="currentColor"
      transform="rotate(45deg)"
      transformOrigin="left center"
      borderRadius="full"
    />
  </Box>
)

export default function App() {
  return (
    <Box minH="100vh" position="relative" overflow="hidden">
      <Box
        position="absolute"
        inset="0"
        bgGradient="linear(to-b, sand.50, sand.100 55%, sand.50)"
      />
      <Box
        position="absolute"
        top={{ base: '-120px', lg: '-180px' }}
        right={{ base: '-160px', lg: '-220px' }}
        w={{ base: '260px', lg: '380px' }}
        h={{ base: '260px', lg: '380px' }}
        bg="radial-gradient(circle at 30% 30%, var(--app-accent-glow), rgba(0, 0, 0, 0))"
        filter="blur(10px)"
        opacity="0.9"
        animation={`${drift} 16s ease-in-out infinite`}
      />
      <Box
        position="absolute"
        bottom={{ base: '-140px', lg: '-180px' }}
        left={{ base: '-160px', lg: '-220px' }}
        w={{ base: '280px', lg: '420px' }}
        h={{ base: '280px', lg: '420px' }}
        bg="radial-gradient(circle at 30% 30%, rgba(139,92,246,0.18), rgba(139,92,246,0))"
        filter="blur(12px)"
        opacity="0.9"
      />
      <Box
        position="absolute"
        inset="0"
        bgImage="linear-gradient(to right, rgba(255, 255, 255, 0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255, 255, 255, 0.04) 1px, transparent 1px)"
        bgSize="48px 48px"
        opacity="0.35"
        pointerEvents="none"
      />

      <Box position="relative">
        <PageHeader
          bg="sand.50/90"
          actions={
            <>
              <InputGroup
                size="sm"
                w={{ base: '160px', md: '220px' }}
                startElement={<SearchGlyph />}
              >
                <Input
                  placeholder="Search docs"
                  bg="sand.100"
                  border="1px solid"
                  borderColor="sand.200"
                  color="ink.900"
                  _placeholder={{ color: 'ink.700' }}
                  _focusVisible={{
                    borderColor: 'tide.400',
                    boxShadow: '0 0 0 1px var(--app-accent-ring)',
                  }}
                />
              </InputGroup>
              <ReloadButton />
              <ThemeToggleButton />
            </>
          }
        />

        <Container maxW="1240px" px={{ base: 4, md: 8 }} py={{ base: 8, md: 10 }}>
          <PageBreadcrumb>
            <BreadcrumbRoot fontSize="sm" color="ink.700">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink as={RouterLink} to="/">
                    Dashboard
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator>/</BreadcrumbSeparator>
                <BreadcrumbItem>
                  <BreadcrumbCurrentLink color="ink.900">Docs</BreadcrumbCurrentLink>
                </BreadcrumbItem>
              </BreadcrumbList>
            </BreadcrumbRoot>
          </PageBreadcrumb>
          <Stack spacing={{ base: 6, md: 8 }}>
            <Grid
              templateColumns={{
                base: '1fr',
                lg: '240px minmax(0, 1fr)',
                xl: '240px minmax(0, 1fr) 220px',
              }}
              gap={{ base: 8, lg: 10 }}
              alignItems="start"
            >
              <Box
                display={{ base: 'none', lg: 'block' }}
                position="sticky"
                top="96px"
                h="calc(100vh - 120px)"
                overflowY="auto"
                pr="4"
                animation={`${fadeUp} 0.5s ease`}
              >
                <VStack align="stretch" spacing="6">
                  {navSections.map((section) => (
                    <Box key={section.title}>
                      <Text
                        fontSize="xs"
                        letterSpacing="0.24em"
                        textTransform="uppercase"
                        color="ink.700"
                        mb="3"
                      >
                        {section.title}
                      </Text>
                      <VStack align="stretch" spacing="1">
                        {section.items.map((item) => (
                          <NavItem
                            key={item}
                            label={item}
                            active={item === 'CLI'}
                          />
                        ))}
                      </VStack>
                    </Box>
                  ))}
                </VStack>
              </Box>

              <Box
                animation={`${fadeUp} 0.6s ease`}
                style={{ animationDelay: '0.1s', animationFillMode: 'both' }}
              >
                <Stack spacing="8" maxW="760px">
                <Stack spacing="4">
                  <HStack spacing="3">
                    <Badge
                      bg="tide.500"
                      color="ink.900"
                      borderRadius="full"
                      px="3"
                      py="1"
                      fontSize="0.65rem"
                      letterSpacing="0.2em"
                      textTransform="uppercase"
                    >
                      Docs
                    </Badge>
                    <Text fontSize="xs" color="ink.700" letterSpacing="0.2em">
                      Updated Sep 2024
                    </Text>
                  </HStack>
                  <Heading
                    as="h1"
                    fontSize={{ base: '3xl', md: '4xl', lg: '5xl' }}
                    lineHeight="1.1"
                  >
                    CLI
                  </Heading>
                  <Text fontSize={{ base: 'md', md: 'lg' }} color="ink.700">
                    Generate typings, create snippets, and keep your design tokens
                    aligned across every build. The CLI is the fastest way to
                    standardize your component library.
                  </Text>
                </Stack>

                <Flex
                  bg="rgba(139, 92, 246, 0.18)"
                  border="1px solid"
                  borderColor="rgba(139, 92, 246, 0.4)"
                  borderRadius="lg"
                  p="4"
                  gap="3"
                  align="center"
                >
                  <Badge
                    bg="violet.500"
                    color="ink.900"
                    borderRadius="full"
                    px="3"
                    py="1"
                    fontSize="0.65rem"
                    letterSpacing="0.18em"
                    textTransform="uppercase"
                  >
                    AI Tip
                  </Badge>
                  <Text fontSize="sm" color="ink.900">
                    Skip the docs and use the MCP server for guided setup in your
                    editor.
                  </Text>
                </Flex>

                <Stack spacing="4">
                  <Heading as="h2" size="lg">
                    Installation
                  </Heading>
                  <Text color="ink.700">
                    Install the CLI as a dev dependency so your build pipeline can
                    generate theme metadata and type-safe recipes.
                  </Text>
                  <Box
                    border="1px solid"
                    borderColor="sand.200"
                    borderRadius="lg"
                    overflow="hidden"
                  >
                    <Box
                      bg="sand.100"
                      px="4"
                      py="2"
                      fontSize="sm"
                      color="ink.700"
                      borderBottom="1px solid"
                      borderColor="sand.200"
                    >
                      Terminal
                    </Box>
                    <Box
                      as="pre"
                      bg="sand.300"
                      color="ink.900"
                      px="4"
                      py="4"
                      fontSize="sm"
                      fontFamily="mono"
                      overflowX="auto"
                    >
                      npm i -D @chakra-ui/cli
                    </Box>
                  </Box>
                </Stack>

                <Stack spacing="4">
                  <Heading as="h2" size="lg">
                    What you get
                  </Heading>
                  <Grid
                    templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)' }}
                    gap="4"
                  >
                    {[
                      {
                        title: 'Type-safe tokens',
                        body: 'Generate typings for color, radius, and recipe variants.',
                      },
                      {
                        title: 'Snippet export',
                        body: 'Ship reusable UI snippets with consistent naming.',
                      },
                      {
                        title: 'Structured output',
                        body: 'Keep JSON and CSV in sync for audits and analytics.',
                      },
                      {
                        title: 'Fast onboarding',
                        body: 'New contributors get a CLI-first workflow on day one.',
                      },
                    ].map((item) => (
                      <Box
                        key={item.title}
                        p="4"
                        borderRadius="xl"
                        bg="sand.100"
                        border="1px solid"
                        borderColor="sand.200"
                      >
                        <Text fontWeight="600" mb="2">
                          {item.title}
                        </Text>
                        <Text fontSize="sm" color="ink.700">
                          {item.body}
                        </Text>
                      </Box>
                    ))}
                  </Grid>
                </Stack>
              </Stack>
            </Box>

            <Box
              display={{ base: 'none', xl: 'block' }}
              position="sticky"
              top="96px"
              h="calc(100vh - 120px)"
              animation={`${fadeUp} 0.6s ease`}
              style={{ animationDelay: '0.2s', animationFillMode: 'both' }}
            >
              <Stack spacing="6">
                <Box>
                  <Text fontSize="sm" fontWeight="600" mb="3">
                    On this page
                  </Text>
                  <VStack align="start" spacing="2">
                    {tocItems.map((item) => (
                      <Text
                        key={item.label}
                        fontSize="sm"
                        color={item.label === 'Installation' ? 'tide.300' : 'ink.700'}
                        fontWeight={item.label === 'Installation' ? '600' : '500'}
                        pl={item.depth ? '4' : '0'}
                      >
                        {item.label}
                      </Text>
                    ))}
                  </VStack>
                </Box>

                <Box
                  p="4"
                  borderRadius="xl"
                  bg="rgba(139, 92, 246, 0.18)"
                  border="1px solid"
                  borderColor="rgba(139, 92, 246, 0.4)"
                >
                  <Text fontWeight="600" mb="2">
                    Master the system
                  </Text>
                  <Text fontSize="sm" color="ink.700" mb="4">
                    Learn how to ship a complete design system with docs,
                    templates, and release automation.
                  </Text>
                  <Button
                    size="sm"
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: 'violet.400' }}
                    w="full"
                  >
                    Watch series
                  </Button>
                </Box>
              </Stack>
            </Box>
          </Grid>
        </Stack>
        </Container>
      </Box>
    </Box>
  )
}
